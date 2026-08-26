import json
import base64
import concurrent.futures
import hmac
import html as html_lib
import mimetypes
import os
import re
import socket
import threading
import time
import uuid
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PUBLIC_DIR = ROOT / "public"
DATA_DIR = Path(os.getenv("DATA_DIR", str(ROOT / "data"))).resolve()
STATE_FILE = DATA_DIR / "state.json"
BUNDLED_STATE_FILE = ROOT / "data" / "state.json"
MAX_BODY_BYTES = 12 * 1024 * 1024
STATE_LOCK = threading.RLock()
JINA_RATE_LOCK = threading.Lock()
JINA_LAST_REQUEST_AT = 0.0
DATABASE_SCHEMA_LOCK = threading.Lock()
DATABASE_SCHEMA_READY = False


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def load_env():
    path = ROOT / ".env"
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        match = re.match(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$", line)
        if match and match.group(1) not in os.environ:
            os.environ[match.group(1)] = match.group(2).strip("'\"")


def default_state():
    return {"corpus": [], "feedback": [], "generations": 0, "createdAt": now_iso()}


def bundled_or_default_state():
    bundled = read_bundled_state()
    if bundled is not None and BUNDLED_STATE_FILE.resolve() != STATE_FILE.resolve():
        return bundled
    return default_state()


def read_bundled_state():
    if BUNDLED_STATE_FILE.exists():
        try:
            bundled = json.loads(BUNDLED_STATE_FILE.read_text(encoding="utf-8"))
            return {**default_state(), **bundled}
        except json.JSONDecodeError:
            pass
    return None


def postgres_url():
    return os.getenv("POSTGRES_URL", "").strip()


def database_connection():
    try:
        import psycopg
    except ImportError as error:
        raise RuntimeError("A dependência do Supabase não foi instalada.") from error
    return psycopg.connect(postgres_url(), connect_timeout=10)


def ensure_database_schema(connection):
    global DATABASE_SCHEMA_READY
    if DATABASE_SCHEMA_READY:
        return
    with DATABASE_SCHEMA_LOCK:
        if DATABASE_SCHEMA_READY:
            return
        connection.execute("""
            CREATE TABLE IF NOT EXISTS caption_lab_state (
                id TEXT PRIMARY KEY,
                payload JSONB NOT NULL,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """)
        seed = read_bundled_state() or default_state()
        connection.execute(
            "INSERT INTO caption_lab_state (id, payload) VALUES ('main', %s::jsonb) ON CONFLICT (id) DO NOTHING",
            (json.dumps(seed, ensure_ascii=False),)
        )
        connection.commit()
        DATABASE_SCHEMA_READY = True


def read_database_state():
    with database_connection() as connection:
        ensure_database_schema(connection)
        row = connection.execute("SELECT payload FROM caption_lab_state WHERE id = 'main'").fetchone()
        if not row:
            raise RuntimeError("O estado do Caption Lab não foi encontrado no Supabase.")
        payload = row[0] if isinstance(row[0], dict) else json.loads(row[0])
        return {**default_state(), **payload}


def write_database_state(state):
    with database_connection() as connection:
        ensure_database_schema(connection)
        connection.execute(
            """
            INSERT INTO caption_lab_state (id, payload, updated_at)
            VALUES ('main', %s::jsonb, NOW())
            ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()
            """,
            (json.dumps(state, ensure_ascii=False),)
        )
        connection.commit()


def read_state():
    with STATE_LOCK:
        if postgres_url():
            return read_database_state()
        try:
            data = json.loads(STATE_FILE.read_text(encoding="utf-8"))
            return {**default_state(), **data}
        except (FileNotFoundError, json.JSONDecodeError):
            return default_state()


def write_state(state):
    with STATE_LOCK:
        if postgres_url():
            write_database_state(state)
            return
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        temporary = DATA_DIR / f".{STATE_FILE.name}.{uuid.uuid4().hex}.tmp"
        temporary.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(temporary, STATE_FILE)


def unit_name(value):
    return "Linhares" if value == "Linhares" else "Colatina"


def ai_config():
    groq_key = os.getenv("GROQ_API_KEY", "").strip()
    if groq_key:
        return {
            "provider": "Groq",
            "api_key": groq_key,
            "model": os.getenv("GROQ_MODEL", "qwen/qwen3.8-27b"),
            "url": "https://api.groq.com/openai/v1/responses"
        }
    openai_key = os.getenv("OPENAI_API_KEY", "").strip()
    if openai_key:
        return {
            "provider": "OpenAI",
            "api_key": openai_key,
            "model": os.getenv("OPENAI_MODEL", "gpt-4o-mini"),
            "url": "https://api.openai.com/v1/responses"
        }
    return None


def short(value, maximum):
    return str(value or "").strip()[:maximum]


def clean_topic(value):
    value = re.sub(r"\s+", " ", str(value or "")).strip()
    return re.sub(r"[.!?]+$", "", value)[:180]


def choose_cta(value, goal):
    if value and value != "Automático":
        return value
    options = {
        "Matrículas": "Fale com a nossa equipe e conheça a Darwin.",
        "Engajamento": "Conte para a gente nos comentários!",
        "Informação": "Salve este post para consultar depois.",
        "Comunidade": "Compartilhe com quem também faz parte dessa história."
    }
    return options.get(goal, options["Engajamento"])


def instagram_token(unit):
    suffix = "LINHARES" if unit == "Linhares" else "COLATINA"
    return os.getenv(f"INSTAGRAM_TOKEN_{suffix}", "").strip()


def apify_token():
    return os.getenv("APIFY_API_TOKEN", "").strip()


def parse_post_date(value):
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(value, timezone.utc)
    text = str(value or "").strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def import_public_instagram(profile_url, start_date, unit):
    token = apify_token()
    if not token:
        raise ValueError("Cadastre APIFY_API_TOKEN na hospedagem para ler perfis públicos sem ser proprietário.")

    actor_id = os.getenv("APIFY_ACTOR_ID", "apify~instagram-scraper")
    max_posts = min(2000, max(1, int(os.getenv("APIFY_MAX_POSTS", "1000"))))
    endpoint = f"https://api.apify.com/v2/acts/{urllib.parse.quote(actor_id, safe='~')}/run-sync-get-dataset-items?timeout=300&clean=true"
    actor_input = {
        "directUrls": [profile_url],
        "resultsType": "posts",
        "resultsLimit": max_posts,
        "searchType": "user",
        "searchLimit": 1,
        "addParentData": False,
        "onlyPostsNewerThan": start_date
    }
    request = urllib.request.Request(
        endpoint,
        data=json.dumps(actor_input).encode("utf-8"),
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}"
        },
        method="POST"
    )
    try:
        with urllib.request.urlopen(request, timeout=330) as response:
            rows = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        try:
            details = json.loads(error.read().decode("utf-8"))
            message = details.get("error", {}).get("message", "A Apify recusou a coleta.")
        except Exception:
            message = "A Apify recusou a coleta."
        raise RuntimeError(message) from error
    except urllib.error.URLError as error:
        raise RuntimeError("Não foi possível conectar à Apify.") from error

    cutoff = datetime.fromisoformat(start_date).replace(tzinfo=timezone.utc)
    items = []
    detected_username = ""
    for row in rows if isinstance(rows, list) else []:
        caption = short(row.get("caption"), 5000)
        posted_at = parse_post_date(row.get("timestamp") or row.get("takenAt") or row.get("date"))
        if not caption or not posted_at or posted_at < cutoff or posted_at > datetime.now(timezone.utc):
            continue
        detected_username = detected_username or str(row.get("ownerUsername") or row.get("username") or "")
        post_key = row.get("id") or row.get("shortCode") or row.get("url") or uuid.uuid4().hex
        permalink = row.get("url") or (f"https://www.instagram.com/p/{row.get('shortCode')}/" if row.get("shortCode") else "")
        items.append({
            "id": f"instagram:{post_key}",
            "unit": unit,
            "caption": caption,
            "date": posted_at.isoformat(),
            "source": f"Instagram @{detected_username}" if detected_username else "Instagram público",
            "permalink": short(permalink, 500),
            "createdAt": now_iso()
        })
    return {"items": items, "scanned": len(rows) if isinstance(rows, list) else 0, "username": detected_username}


def normalize_instagram_post_url(value):
    raw = str(value or "").strip()
    if not re.match(r"^https?://", raw, re.I):
        raw = "https://" + raw
    parsed = urllib.parse.urlparse(raw)
    host = parsed.netloc.lower().split(":")[0]
    parts = [part for part in parsed.path.split("/") if part]
    if host not in {"instagram.com", "www.instagram.com"} or len(parts) < 2 or parts[0] not in {"p", "reel", "tv"}:
        raise ValueError("Link de publicação inválido.")
    shortcode = re.sub(r"[^A-Za-z0-9_-]", "", parts[1])
    if not shortcode:
        raise ValueError("Link de publicação inválido.")
    return f"https://www.instagram.com/{parts[0]}/{shortcode}/", parts[0], shortcode


def decode_json_string(value):
    try:
        return json.loads(f'"{value}"')
    except json.JSONDecodeError:
        return value.replace("\\n", "\n").replace("\\\"", '"')


def extract_caption_from_embed(source):
    json_patterns = [
        r'"caption"\s*:\s*\{[^{}]*?"text"\s*:\s*"((?:\\.|[^"\\])*)"',
        r'"caption"\s*:\s*"((?:\\.|[^"\\])*)"'
    ]
    for pattern in json_patterns:
        match = re.search(pattern, source, re.S)
        if match:
            caption = html_lib.unescape(decode_json_string(match.group(1))).strip()
            if caption:
                return caption

    # Procura somente dentro de cada tag <meta>. O padrão anterior podia
    # retroceder pelo HTML inteiro do Instagram e consumir CPU indefinidamente.
    source_lower = source.lower()
    cursor = 0
    attribute_pattern = re.compile(r'([:\w-]+)\s*=\s*(["\'])(.*?)\2', re.S)
    while True:
        start = source_lower.find("<meta", cursor)
        if start < 0:
            break
        end = source.find(">", start + 5)
        if end < 0:
            break
        cursor = end + 1
        if end - start > 8192:
            continue
        attributes = {
            name.lower(): html_lib.unescape(value)
            for name, _, value in attribute_pattern.findall(source[start:end + 1])
        }
        if attributes.get("property", "").lower() != "og:description":
            continue
        description = attributes.get("content", "").strip()
        if not description:
            continue
        quoted = re.search(r':\s*["“](.*?)["”]\.?$', description, re.S)
        return (quoted.group(1) if quoted else description).strip()
    return ""


def read_instagram_with_jina(canonical, shortcode):
    global JINA_LAST_REQUEST_AT
    api_key = os.getenv("JINA_API_KEY", "").strip()
    interval = 0.7 if api_key else 3.1
    with JINA_RATE_LOCK:
        delay = JINA_LAST_REQUEST_AT + interval - time.monotonic()
        if delay > 0:
            time.sleep(delay)
        JINA_LAST_REQUEST_AT = time.monotonic()

    reader_url = "https://r.jina.ai/http://www.instagram.com" + urllib.parse.urlparse(canonical).path
    headers = {
        "Accept": "text/plain",
        "User-Agent": "Darwin-Caption-Lab/1.0"
    }
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    request = urllib.request.Request(reader_url, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            markdown = response.read(2 * 1024 * 1024).decode("utf-8", errors="replace")
    except urllib.error.HTTPError as error:
        if error.code == 429:
            raise RuntimeError("O leitor gratuito atingiu o limite temporário. Aguarde um minuto e tente novamente.") from error
        raise RuntimeError(f"O leitor público respondeu com status {error.code}.") from error
    except urllib.error.URLError as error:
        raise RuntimeError("O leitor público não respondeu.") from error

    title_end = markdown.find("\n\nURL Source:")
    title = markdown[len("Title:"):title_end].strip() if markdown.startswith("Title:") and title_end > 0 else ""
    marker = " on Instagram: \""
    marker_position = title.find(marker)
    if marker_position >= 0 and title.endswith('"'):
        caption = title[marker_position + len(marker):-1].strip()
        if caption:
            return {"shortcode": shortcode, "url": canonical, "caption": caption, "date": ""}
    raise RuntimeError("A legenda não estava disponível no leitor público.")


def read_public_instagram_post(value):
    canonical, kind, shortcode = normalize_instagram_post_url(value)
    embed_url = f"https://www.instagram.com/{kind}/{shortcode}/embed/captioned/"
    request = urllib.request.Request(embed_url, headers={
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36"
    })
    source = ""
    try:
        with urllib.request.urlopen(request, timeout=12) as response:
            source = response.read(5 * 1024 * 1024).decode("utf-8", errors="replace")
    except (urllib.error.HTTPError, urllib.error.URLError):
        pass

    if source:
        caption = extract_caption_from_embed(source)
        if caption:
            date_match = re.search(r'"(?:uploadDate|datePublished|taken_at_timestamp)"\s*:\s*"?([^",}]+)', source)
            posted_at = date_match.group(1) if date_match else ""
            return {"shortcode": shortcode, "url": canonical, "caption": caption, "date": posted_at}
    return read_instagram_with_jina(canonical, shortcode)


def import_instagram_links(links, unit, start_date):
    unique = list(dict.fromkeys(link.strip() for link in links if link.strip()))
    if not unique:
        raise ValueError("Cole pelo menos um link de publicação.")
    if len(unique) > 500:
        raise ValueError("Importe no máximo 500 links por vez.")

    items = []
    failures = []
    # Poucas leituras simultâneas mantêm a interface responsiva mesmo quando
    # as páginas incorporadas do Instagram são grandes.
    worker_count = min(4, len(unique))
    with concurrent.futures.ThreadPoolExecutor(max_workers=worker_count) as executor:
        future_map = {executor.submit(read_public_instagram_post, link): link for link in unique}
        for future in concurrent.futures.as_completed(future_map):
            link = future_map[future]
            try:
                post = future.result()
                parsed_date = parse_post_date(post["date"])
                cutoff = datetime.fromisoformat(start_date).replace(tzinfo=timezone.utc)
                if parsed_date and parsed_date < cutoff:
                    continue
                items.append({
                    "id": f"instagram:{post['shortcode']}",
                    "unit": unit,
                    "caption": short(post["caption"], 5000),
                    "date": parsed_date.isoformat() if parsed_date else "",
                    "source": "Instagram por links",
                    "permalink": post["url"],
                    "createdAt": now_iso()
                })
            except Exception as error:
                failures.append({"url": short(link, 500), "error": short(str(error), 200)})
    return {"items": items, "scanned": len(unique), "failures": failures}


def instagram_get(url):
    request = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        try:
            details = json.loads(error.read().decode("utf-8"))
            message = details.get("error", {}).get("message", "O Instagram recusou a solicitação.")
        except Exception:
            message = "O Instagram recusou a solicitação."
        raise RuntimeError(message) from error
    except urllib.error.URLError as error:
        raise RuntimeError("Não foi possível conectar ao Instagram.") from error


def import_instagram_profile(unit, profile_url, start_date):
    token = instagram_token(unit)
    if not token:
        raise ValueError(f"O Instagram de {unit} ainda não foi autorizado no servidor.")

    raw_url = profile_url.strip()
    if not re.match(r"^https?://", raw_url, re.I):
        raw_url = "https://" + raw_url
    parsed = urllib.parse.urlparse(raw_url)
    host = parsed.netloc.lower().split(":")[0]
    if host not in {"instagram.com", "www.instagram.com"}:
        raise ValueError("Cole um link válido de perfil do Instagram.")
    parts = [part for part in parsed.path.split("/") if part]
    if not parts or parts[0] in {"p", "reel", "stories", "explore"}:
        raise ValueError("O link precisa apontar para um perfil, não para uma publicação.")
    requested_username = parts[0].lstrip("@").lower()

    graph_base = os.getenv("INSTAGRAM_GRAPH_URL", "https://graph.instagram.com").rstrip("/")
    encoded_token = urllib.parse.quote(token, safe="")
    profile = instagram_get(f"{graph_base}/me?fields=id,user_id,username&access_token={encoded_token}")
    connected_username = str(profile.get("username") or "").lower()
    if connected_username and connected_username != requested_username:
        raise ValueError(
            f"O link é @{requested_username}, mas a autorização de {unit} pertence a @{connected_username}."
        )

    fields = "id,caption,timestamp,permalink,media_type"
    next_url = f"{graph_base}/me/media?fields={fields}&limit=100&access_token={encoded_token}"
    imported = []
    scanned = 0
    pages = 0

    while next_url and pages < 200:
        page = instagram_get(next_url)
        pages += 1
        for media in page.get("data", []):
            scanned += 1
            caption = short(media.get("caption"), 5000)
            timestamp = str(media.get("timestamp") or "")
            posted_at = parse_post_date(timestamp)
            if not posted_at:
                continue
            cutoff = datetime.fromisoformat(start_date).replace(tzinfo=timezone.utc)
            if caption and cutoff <= posted_at <= datetime.now(timezone.utc):
                imported.append({
                    "id": f"instagram:{media.get('id')}",
                    "unit": unit,
                    "caption": caption,
                    "date": timestamp,
                    "source": f"Instagram @{connected_username or requested_username}",
                    "permalink": short(media.get("permalink"), 500),
                    "createdAt": now_iso()
                })
        next_url = page.get("paging", {}).get("next")

    return {
        "items": imported,
        "scanned": scanned,
        "username": connected_username or requested_username,
        "pages": pages
    }


def generate_demo(body, state):
    topic = clean_topic(body.get("brief")) or "essa novidade"
    unit = unit_name(body.get("unit"))
    liked = next((item for item in state["feedback"] if item.get("unit") == unit and item.get("rating") == "like"), None)
    learned = "Voz ajustada pelos feedbacks anteriores." if liked else "Importe legendas anteriores para aproximar ainda mais a voz."
    emoji_level = body.get("emojiLevel")
    emoji = "" if emoji_level == "Sem emojis" else " 💚✨📚" if emoji_level == "Mais emojis" else " 💚"
    cta = choose_cta(body.get("cta"), body.get("goal"))
    hashtags = f"#Darwin{unit} #Darwin #Educação #{unit}"
    topic_cap = topic[0].upper() + topic[1:] if topic else topic
    topic_low = topic[0].lower() + topic[1:] if topic else topic

    rows = [
        {
            "label": "Direta",
            "strategy": f"Clareza + benefício • {learned}",
            "text": f"{topic_cap}: um convite para aprender, descobrir e ir além.{emoji}\n\nNa Darwin {unit}, cada experiência é pensada para transformar curiosidade em conhecimento e preparar nossos estudantes para tudo o que vem pela frente.\n\n{cta}\n\n{hashtags}"
        },
        {
            "label": "Narrativa",
            "strategy": f"Conexão emocional + propósito • {learned}",
            "text": f"Todo grande passo começa com uma descoberta.{emoji}\n\n{topic_cap} representa mais do que um momento: é a chance de viver novas experiências, compartilhar aprendizados e construir memórias que acompanham nossos estudantes dentro e fora da sala de aula.\n\nÉ assim que a Darwin {unit} transforma o presente e abre caminhos para o futuro. {cta}\n\n{hashtags}"
        },
        {
            "label": "Conversa",
            "strategy": f"Pergunta + proximidade • {learned}",
            "text": f"O que acontece quando conhecimento e curiosidade se encontram?{emoji}\n\nCom {topic_low}, nossos estudantes participam, experimentam e descobrem novas formas de enxergar o mundo — sempre com o acolhimento e a excelência da Darwin {unit}.\n\n{cta}\n\n{hashtags}"
        }
    ]
    return [{"id": str(uuid.uuid4()), **row} for row in rows]


def generate_with_ai(body, state, config):
    unit = unit_name(body.get("unit"))
    corpus = "\n\n".join(
        f"EXEMPLO {index + 1}: {item.get('caption', '')}"
        for index, item in enumerate([item for item in state["corpus"] if item.get("unit") == unit][:80])
    )[:45000]
    liked = "\n\n".join(
        f"APROVADA: {item.get('caption', '')}"
        for item in [item for item in state["feedback"] if item.get("unit") == unit and item.get("rating") == "like"][:20]
    )[:12000]
    disliked = "\n\n".join(
        f"EVITAR: {item.get('caption', '')} | Motivo: {item.get('reason', '')}"
        for item in [item for item in state["feedback"] if item.get("unit") == unit and item.get("rating") == "dislike"][:12]
    )[:7000]

    instructions = f"""Você é estrategista de conteúdo e copywriter da Darwin, unidade {unit}. Crie legendas de Instagram em português brasileiro, naturais e prontas para publicação.

Aprenda o padrão editorial a partir dos exemplos. Não copie frases inteiras. Preserve voz, estrutura, ritmo e densidade de emojis. Diferencie a unidade quando houver evidência. Nunca invente preços, datas, resultados, profissionais, endereços ou condições. Se faltar um dado essencial, escreva de modo seguro sem fabricá-lo.

Gere exatamente 3 opções diferentes: uma direta, uma narrativa e uma de conversa. Cada uma deve ter abertura forte, desenvolvimento, CTA coerente e hashtags relevantes. Respeite tamanho, emojis, objetivo e tipo de conteúdo. Retorne somente JSON conforme o schema."""

    prompt = f"""BRIEFING
Unidade: {unit}
Tipo: {body.get('contentType', 'Post de feed')}
Objetivo: {body.get('goal', 'Engajamento')}
Tamanho: {body.get('length', 'Médio')}
Emojis: {body.get('emojiLevel', 'Equilibrado')}
CTA: {body.get('cta', 'Automático')}
Ideia/informações: {body.get('brief') or 'Analise a imagem e crie uma legenda adequada.'}

BASE DE VOZ DA UNIDADE
{corpus or 'Ainda não há legendas importadas. Use uma voz educacional, acolhedora, confiante e contemporânea.'}

FEEDBACKS POSITIVOS
{liked or 'Ainda não há feedbacks positivos.'}

FEEDBACKS NEGATIVOS
{disliked or 'Ainda não há feedbacks negativos.'}"""

    content = [{"type": "input_text", "text": prompt}]
    image = body.get("image")
    if isinstance(image, str) and image.startswith("data:image/"):
        content.append({"type": "input_image", "image_url": image, "detail": "auto"})

    payload = {
        "model": config["model"],
        "instructions": instructions,
        "input": [{"role": "user", "content": content}],
        "text": {"format": {
            "type": "json_schema",
            "name": "caption_options",
            "strict": True,
            "schema": {
                "type": "object",
                "additionalProperties": False,
                "required": ["captions"],
                "properties": {"captions": {
                    "type": "array", "minItems": 3, "maxItems": 3,
                    "items": {
                        "type": "object", "additionalProperties": False,
                        "required": ["label", "text", "strategy"],
                        "properties": {
                            "label": {"type": "string"},
                            "text": {"type": "string"},
                            "strategy": {"type": "string"}
                        }
                    }
                }}
            }
        }},
        "max_output_tokens": 1800
    }
    if config["provider"] == "OpenAI":
        payload["store"] = False

    request = urllib.request.Request(
        config["url"],
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {config['api_key']}"
        },
        method="POST"
    )
    try:
        with urllib.request.urlopen(request, timeout=90) as response:
            data = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        try:
            details = json.loads(error.read().decode("utf-8"))
            message = details.get("error", {}).get("message", f"A {config['provider']} recusou a solicitação.")
        except Exception:
            message = f"A {config['provider']} recusou a solicitação."
        raise RuntimeError(message) from error
    except urllib.error.URLError as error:
        raise RuntimeError("Não foi possível conectar à API. Verifique a internet.") from error

    output_text = data.get("output_text")
    if not output_text:
        for item in data.get("output", []):
            for part in item.get("content", []):
                if part.get("type") == "output_text":
                    output_text = part.get("text")
                    break
    if not output_text:
        raise RuntimeError("A IA não retornou uma legenda.")
    parsed = json.loads(output_text)
    return [{"id": str(uuid.uuid4()), **item} for item in parsed["captions"]]


class AppHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PUBLIC_DIR), **kwargs)

    def log_message(self, fmt, *args):
        print(f"[{self.log_date_time_string()}] {fmt % args}")

    def authenticated(self):
        password = os.getenv("APP_PASSWORD", "")
        if not password:
            return True
        username = os.getenv("APP_USERNAME", "upli")
        expected = "Basic " + base64.b64encode(f"{username}:{password}".encode("utf-8")).decode("ascii")
        received = self.headers.get("Authorization", "")
        if hmac.compare_digest(received, expected):
            return True
        self.send_response(401)
        self.send_header("WWW-Authenticate", 'Basic realm="Darwin Caption Lab", charset="UTF-8"')
        self.send_header("Content-Length", "0")
        self.end_headers()
        return False

    def send_json(self, status, payload):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def read_json(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length > MAX_BODY_BYTES:
            raise ValueError("O arquivo é grande demais. Use uma imagem de até 8 MB.")
        raw = self.rfile.read(length)
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            text = raw.decode("latin-1")
        return json.loads(text or "{}")

    def normalize_route(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path in {"/api", "/api/index.py"}:
            path = urllib.parse.parse_qs(parsed.query).get("path", [""])[0].strip("/")
            self.path = f"/api/{path}" if path else "/api"
        else:
            self.path = parsed.path

    def do_GET(self):
        self.normalize_route()
        if self.path != "/api/health" and not self.authenticated():
            return
        if self.path == "/api/health":
            config = ai_config()
            return self.send_json(200, {
                "ok": True,
                "aiConfigured": bool(config),
                "provider": config["provider"] if config else None,
                "model": config["model"] if config else "modo demonstração",
                "instagramConfigured": {
                    "Colatina": bool(apify_token() or instagram_token("Colatina")),
                    "Linhares": bool(apify_token() or instagram_token("Linhares"))
                },
                "instagramProvider": "Apify" if apify_token() else "Meta" if instagram_token("Colatina") or instagram_token("Linhares") else None
                ,"storage": "Supabase" if postgres_url() else "arquivo local"
            })
        if self.path == "/api/state":
            return self.send_json(200, read_state())
        if self.path.startswith("/api/"):
            return self.send_json(404, {"error": "Rota não encontrada."})
        if self.path not in ("/", "/index.html") and not (PUBLIC_DIR / self.path.lstrip("/")).exists():
            self.path = "/index.html"
        return super().do_GET()

    def do_POST(self):
        self.normalize_route()
        if not self.authenticated():
            return
        try:
            body = self.read_json()
            if self.path == "/api/corpus":
                items = []
                for raw in body.get("items", []):
                    caption = short(raw.get("caption"), 5000)
                    if not caption:
                        continue
                    items.append({
                        "id": raw.get("id") or str(uuid.uuid4()),
                        "unit": unit_name(raw.get("unit")),
                        "caption": caption,
                        "date": short(raw.get("date"), 30),
                        "source": short(raw.get("source") or "Manual", 80),
                        "createdAt": raw.get("createdAt") or now_iso()
                    })
                with STATE_LOCK:
                    state = read_state()
                    state["corpus"] = items + state["corpus"]
                    write_state(state)
                return self.send_json(201, {"added": len(items), "state": state})

            if self.path == "/api/feedback":
                entry = {
                    "id": str(uuid.uuid4()),
                    "generationId": short(body.get("generationId"), 80),
                    "rating": "like" if body.get("rating") == "like" else "dislike",
                    "unit": unit_name(body.get("unit")),
                    "caption": short(body.get("caption"), 5000),
                    "reason": short(body.get("reason"), 1000),
                    "createdAt": now_iso()
                }
                with STATE_LOCK:
                    state = read_state()
                    state["feedback"] = [item for item in state["feedback"] if item.get("generationId") != entry["generationId"]]
                    state["feedback"].insert(0, entry)
                    write_state(state)
                return self.send_json(201, {"feedback": entry, "state": state})

            if self.path == "/api/instagram/import":
                unit = unit_name(body.get("unit"))
                profile_url = short(body.get("profileUrl"), 500)
                start_date = short(body.get("startDate"), 10)
                try:
                    cutoff = datetime.fromisoformat(start_date)
                except ValueError:
                    raise ValueError("Selecione um mês inicial válido.")
                if cutoff.year < 2010 or cutoff.date() > datetime.now(timezone.utc).date():
                    raise ValueError("Selecione um mês inicial válido.")
                if not profile_url:
                    raise ValueError("Cole o link do perfil do Instagram.")

                if apify_token():
                    result = import_public_instagram(profile_url, start_date, unit)
                else:
                    result = import_instagram_profile(unit, profile_url, start_date)
                with STATE_LOCK:
                    state = read_state()
                    existing_ids = {item.get("id") for item in state["corpus"]}
                    new_items = [item for item in result["items"] if item["id"] not in existing_ids]
                    state["corpus"] = new_items + state["corpus"]
                    write_state(state)
                return self.send_json(201, {
                    "added": len(new_items),
                    "found": len(result["items"]),
                    "scanned": result["scanned"],
                    "username": result["username"],
                    "state": state
                })

            if self.path == "/api/instagram/links":
                unit = unit_name(body.get("unit"))
                start_date = short(body.get("startDate"), 10)
                try:
                    datetime.fromisoformat(start_date)
                except ValueError:
                    raise ValueError("Selecione um mês inicial válido.")
                raw_links = body.get("links", [])
                links = raw_links if isinstance(raw_links, list) else re.split(r"\s+", str(raw_links))
                result = import_instagram_links(links, unit, start_date)
                with STATE_LOCK:
                    state = read_state()
                    existing_ids = {item.get("id") for item in state["corpus"]}
                    new_items = [item for item in result["items"] if item["id"] not in existing_ids]
                    state["corpus"] = new_items + state["corpus"]
                    write_state(state)
                return self.send_json(201, {
                    "added": len(new_items),
                    "found": len(result["items"]),
                    "scanned": result["scanned"],
                    "failures": result["failures"],
                    "state": state
                })

            if self.path == "/api/generate":
                if not short(body.get("brief"), 5000) and not body.get("image"):
                    return self.send_json(400, {"error": "Envie uma imagem ou descreva a ideia do post."})
                state = read_state()
                config = ai_config()
                if config:
                    captions = generate_with_ai(body, state, config)
                    mode = "ai"
                else:
                    captions = generate_demo(body, state)
                    mode = "demo"
                with STATE_LOCK:
                    state = read_state()
                    state["generations"] = int(state.get("generations", 0)) + len(captions)
                    write_state(state)
                return self.send_json(200, {"captions": captions, "mode": mode})

            return self.send_json(404, {"error": "Rota não encontrada."})
        except (ValueError, json.JSONDecodeError) as error:
            return self.send_json(400, {"error": str(error)})
        except Exception as error:
            print(f"Erro: {error}")
            return self.send_json(500, {"error": str(error) or "Não foi possível concluir a solicitação."})

    def do_DELETE(self):
        self.normalize_route()
        if not self.authenticated():
            return
        if self.path.startswith("/api/corpus/"):
            item_id = self.path.rsplit("/", 1)[-1]
            with STATE_LOCK:
                state = read_state()
                state["corpus"] = [item for item in state["corpus"] if item.get("id") != item_id]
                write_state(state)
            return self.send_json(200, {"ok": True, "state": state})
        return self.send_json(404, {"error": "Rota não encontrada."})


class ExclusiveThreadingHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = False

    def server_bind(self):
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


if __name__ == "__main__":
    load_env()
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not STATE_FILE.exists():
        write_state(bundled_or_default_state())
    port = int(os.getenv("PORT", "4173"))
    host = os.getenv("HOST", "0.0.0.0")
    try:
        server = ExclusiveThreadingHTTPServer((host, port), AppHandler)
    except OSError as error:
        if getattr(error, "winerror", None) == 10048 or error.errno in {48, 98}:
            print(f"A porta {port} já está em uso. Feche a outra janela do Caption Lab e tente novamente.")
            raise SystemExit(1) from error
        raise
    print(f"Darwin Caption Lab disponível em http://{host}:{port}")
    config = ai_config()
    print(f"IA conectada: {config['provider']} ({config['model']})" if config else "Modo demonstração — configure GROQ_API_KEY para ativar a IA")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServidor encerrado.")
