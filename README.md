# Darwin Caption Lab

Criador de legendas para os perfis Darwin Colatina e Darwin Linhares. O aplicativo aprende o padrão editorial a partir de legendas importadas e usa likes/dislikes como memória para as próximas gerações.

## Abrir o projeto

No Windows, basta dar dois cliques em **`iniciar.bat`**. O navegador será aberto automaticamente.

Se preferir iniciar pelo terminal, abra o PowerShell nesta pasta e execute:

```powershell
python server.py
```

Depois, acesse `http://localhost:4173` no navegador.

O sistema funciona imediatamente em **modo demonstração**, sem instalar pacotes.

## Ativar geração real com IA e análise de imagem

1. Duplique `.env.example` com o nome `.env`.
2. Preencha `GROQ_API_KEY` com uma chave válida e recém-gerada.
3. Reinicie `python server.py`.

A chave fica somente no servidor e nunca é enviada ao navegador. A integração usa a Responses API compatível da Groq com leitura de imagens e saída estruturada. O modelo padrão é `qwen/qwen3.8-27b` e pode ser alterado em `GROQ_MODEL`. Se a Groq não estiver configurada, o projeto ainda aceita OpenAI como alternativa.

## Como alimentar a voz

Na tela **Base de voz**, importe um TXT com uma legenda por bloco ou um CSV. Para CSV, o sistema procura colunas chamadas `legenda`, `caption`, `texto`, `copy`, `description` ou `descricao`. Escolha a unidade correta antes de importar.

### Leitura automática do Instagram

Na tela **Base de voz**, clique em **Ler Instagram**, escolha Colatina ou Linhares e cole o link do perfil. O corte padrão está configurado em **agosto de 2024**. O servidor importa somente publicações com legenda até hoje e evita duplicatas pelo ID da publicação.

#### Modo gratuito por links

Se você já possui os links das publicações, escolha **Links dos posts · grátis** e cole um link por linha. O aplicativo visita apenas as páginas públicas, extrai as legendas disponíveis e apresenta quantos links funcionaram ou falharam. Não exige conta externa, token ou pagamento. São aceitos até 500 links por lote.

Esse método depende do conteúdo que o Instagram disponibiliza publicamente. Posts privados, removidos, restritos ou bloqueados pelo Instagram podem falhar; nesses casos, a legenda pode ser adicionada manualmente pela importação TXT/CSV.

Para perfis públicos que a equipe não administra, use a Apify. Crie uma conta no serviço e cadastre o token somente na hospedagem:

```env
APIFY_API_TOKEN=token_da_apify
APIFY_ACTOR_ID=apify~instagram-scraper
APIFY_MAX_POSTS=1000
```

Com `APIFY_API_TOKEN` configurado, a aplicação usa automaticamente a coleta pública e não exige login ou token da escola. O Instagram pode alterar ou limitar o acesso público, portanto a coleta pode precisar de nova tentativa ou manutenção futura.

O Instagram não permite ler todo o histórico de qualquer perfil apenas pelo link. Cada perfil precisa ser profissional e autorizar o aplicativo pela API oficial da Meta. Depois da autorização, cadastre os tokens como segredos no servidor:

```env
INSTAGRAM_TOKEN_COLATINA=token_do_perfil_de_colatina
INSTAGRAM_TOKEN_LINHARES=token_do_perfil_de_linhares
```

Os tokens nunca são enviados ao navegador. O link colado precisa corresponder ao usuário conectado pelo token daquela unidade.

Os dados ficam em `data/state.json`. Esse arquivo contém a base importada, o histórico de avaliações e a contagem de gerações. Use um repositório privado: a cópia presente no projeto também funciona como base inicial do primeiro deploy, sem conter chaves de API.

## Hospedagem na web

O projeto está preparado para produção com `Dockerfile`. O servidor usa `0.0.0.0`, respeita a porta definida pela hospedagem e aceita um diretório persistente pela variável `DATA_DIR`.

### Deploy na Vercel com Supabase

O projeto também está preparado para a runtime Python da Vercel. A integração Supabase injeta `POSTGRES_URL`; quando essa variável existe, o servidor cria automaticamente a tabela `caption_lab_state` e copia as 346 legendas incluídas em `data/state.json` na primeira execução. Depois disso, legendas, likes, dislikes e gerações são persistidos no Supabase.

1. Importe o repositório privado na Vercel.
2. Em **Storage/Marketplace**, instale a integração **Supabase** e conecte-a ao projeto.
3. Configure `GROQ_API_KEY`, `APP_USERNAME` e `APP_PASSWORD` em **Settings > Environment Variables**.
4. Faça um novo deploy para carregar as variáveis.

`POSTGRES_URL` e as demais credenciais do Supabase devem permanecer somente nas variáveis protegidas da Vercel, nunca no Git ou no navegador.

### Deploy no Render

1. Envie esta pasta para um repositório privado no GitHub.
2. No Render, escolha **New > Blueprint** e conecte o repositório.
3. O arquivo `render.yaml` criará o serviço e um disco persistente de 1 GB.
4. Preencha os segredos `GROQ_API_KEY` e `APP_PASSWORD`.
5. Após o deploy, acesse o endereço gerado e entre com o usuário `upli` e a senha configurada.

No primeiro início, se o disco estiver vazio, o servidor copia automaticamente a base incluída em `data/state.json`; neste projeto, ela contém as 346 legendas de Colatina importadas em 26/08/2026. Depois disso, o disco preserva a base de voz e os feedbacks nas próximas publicações. Em outra hospedagem Docker, monte um volume em `/var/data` ou altere `DATA_DIR` para o caminho persistente oferecido pela plataforma.

O disco persistente do Render exige uma instância paga. No plano gratuito, o site pode ser publicado com a base inicial, mas alterações feitas depois do deploy voltam para essa cópia sempre que o serviço reinicia ou sai da hibernação. Para persistência gratuita contínua, conecte um banco externo, como o plano gratuito do Supabase.

Variáveis disponíveis:

- `GROQ_API_KEY`: chave secreta da Groq;
- `GROQ_MODEL`: modelo multimodal usado para geração;
- `OPENAI_API_KEY` e `OPENAI_MODEL`: alternativa opcional;
- `APP_USERNAME`: usuário da proteção de acesso;
- `APP_PASSWORD`: senha obrigatória recomendada para produção;
- `GOOGLE_LOGIN_URL`: URL opcional do fluxo OAuth configurado para entrar com Google;
- `INSTAGRAM_TOKEN_COLATINA`: autorização oficial do perfil de Colatina;
- `INSTAGRAM_TOKEN_LINHARES`: autorização oficial do perfil de Linhares;
- `APIFY_API_TOKEN`: token para coleta de perfis públicos sem acesso administrativo;
- `APIFY_ACTOR_ID`: coletor utilizado na Apify;
- `APIFY_MAX_POSTS`: limite de segurança e custo por execução;
- `DATA_DIR`: pasta persistente dos aprendizados;
- `PORT`: porta fornecida pela hospedagem.

## Recursos

- Perfis editoriais separados por unidade;
- Upload e prévia de JPG, PNG ou WEBP;
- Geração de três abordagens editáveis;
- Importação de histórico em TXT ou CSV;
- Likes, dislikes e motivo opcional de rejeição;
- Métricas de aprovação e sinais aprendidos;
- Cópia rápida, tema escuro e layout responsivo;
- Modo de demonstração local quando a API não estiver configurada.
