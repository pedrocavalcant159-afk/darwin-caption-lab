const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const app = {
  state: { corpus: [], feedback: [], generations: 0 },
  health: { aiConfigured: false, model: "modo demonstração" },
  image: null,
  importUnit: "Colatina",
  instagramUnit: "Colatina",
  instagramMethod: "links",
  corpusFilter: "Todas",
  currentCaptions: [],
  session: { authenticated: false, googleLoginUrl: "", supabaseUrl: "", supabasePublishableKey: "" },
  started: false
};

let supabaseClient = null;
const PASSKEY_ENROLLED_KEY = "captionLabPasskeyEnrolled";

const elements = {
  form: $("#captionForm"),
  brief: $("#brief"),
  imageInput: $("#imageInput"),
  dropZone: $("#dropZone"),
  results: $("#resultsSection"),
  resultsGrid: $("#resultsGrid"),
  generateButton: $("#generateButton"),
  importModal: $("#importModal"),
  instagramModal: $("#instagramModal"),
  helpModal: $("#helpModal"),
  biometricModal: $("#biometricModal")
};

init();

async function init() {
  bindLogin();
  try {
    app.session = await api("/api/session");
    configureSupabase();
    const completedGoogleLogin = await completeGoogleLogin();
    app.session = await api("/api/session");
    updatePasskeyLoginAvailability();
    if (app.session.authenticated) {
      await startApplication();
      if (completedGoogleLogin && !hasEnrolledPasskey()) await openBiometricSetup();
      return;
    }
    $("#loginUsername").value = app.session.username || "";
  } catch (error) {
    setLoginError(error.message);
  }
  $("#loginUsername").focus();
}

function bindLogin() {
  $("#loginForm").addEventListener("submit", loginWithPassword);
  $("#togglePassword").addEventListener("click", () => {
    const input = $("#loginPassword");
    const visible = input.type === "text";
    input.type = visible ? "password" : "text";
    $("#togglePassword").setAttribute("aria-label", visible ? "Mostrar senha" : "Ocultar senha");
    $("#togglePassword").setAttribute("aria-pressed", String(!visible));
  });
  $("#googleLogin").addEventListener("click", () => {
    if (app.session.googleLoginUrl) {
      sessionStorage.setItem("captionLabGoogleRemember", $("#rememberLogin").checked ? "1" : "0");
      return window.location.assign(app.session.googleLoginUrl);
    }
    setLoginError("O acesso com a Conta Google ainda precisa ser configurado pelo administrador.");
  });
  $("#passkeyLogin").addEventListener("click", loginWithPasskey);
  $("#logoutButton").addEventListener("click", logout);
}

function configureSupabase() {
  if (!app.session.supabaseUrl || !app.session.supabasePublishableKey || !window.supabase?.createClient) return;
  supabaseClient = window.supabase.createClient(
    app.session.supabaseUrl,
    app.session.supabasePublishableKey,
    {
      auth: {
        detectSessionInUrl: false,
        persistSession: true,
        autoRefreshToken: true,
        experimental: { passkey: true }
      }
    }
  );
}

function updatePasskeyLoginAvailability() {
  const canSignIn = Boolean(
    hasEnrolledPasskey()
    && supabaseClient
    && window.PublicKeyCredential
    && navigator.credentials
  );
  $("#passkeyLogin").classList.toggle("hidden", !canSignIn);
}

function hasEnrolledPasskey() {
  return localStorage.getItem(PASSKEY_ENROLLED_KEY) === "1";
}

async function completeGoogleLogin() {
  const parameters = new URLSearchParams(window.location.hash.slice(1));
  const accessToken = parameters.get("access_token");
  const refreshToken = parameters.get("refresh_token");
  const oauthError = parameters.get("error_description") || parameters.get("error");
  if (!accessToken && !oauthError) return false;

  history.replaceState({}, document.title, `${window.location.pathname}${window.location.search}`);
  if (oauthError) throw new Error(oauthError);

  const remember = sessionStorage.getItem("captionLabGoogleRemember") === "1";
  sessionStorage.removeItem("captionLabGoogleRemember");
  setLoginError("");
  const button = $("#googleLogin");
  button.disabled = true;
  try {
    const response = await api("/api/login/google", {
      method: "POST",
      body: JSON.stringify({ accessToken, remember })
    });
    if (supabaseClient && refreshToken) {
      const { error } = await supabaseClient.auth.setSession({
        access_token: accessToken,
        refresh_token: refreshToken
      });
      if (error) throw error;
    }
    app.session = { ...app.session, authenticated: true, username: response.username };
    return true;
  } catch (error) {
    try { await supabaseClient?.auth.signOut({ scope: "local" }); } catch {}
    throw error;
  } finally {
    button.disabled = false;
  }
}

async function loginWithPasskey() {
  setLoginError("");
  const button = $("#passkeyLogin");
  button.disabled = true;
  try {
    const { data, error } = await supabaseClient.auth.signInWithPasskey();
    if (error) throw error;
    const accessToken = data?.session?.access_token;
    if (!accessToken) throw new Error("A passkey não retornou uma sessão válida.");
    const response = await api("/api/login/google", {
      method: "POST",
      body: JSON.stringify({ accessToken, remember: $("#rememberLogin").checked })
    });
    app.session = { ...app.session, authenticated: true, username: response.username };
    localStorage.setItem(PASSKEY_ENROLLED_KEY, "1");
    await startApplication();
  } catch (error) {
    try { await supabaseClient?.auth.signOut({ scope: "local" }); } catch {}
    if (String(error?.code || "") === "webauthn_credential_not_found") {
      localStorage.removeItem(PASSKEY_ENROLLED_KEY);
      updatePasskeyLoginAvailability();
    }
    setLoginError(passkeyErrorMessage(error));
  } finally {
    button.disabled = false;
  }
}

async function loginWithPassword(event) {
  event.preventDefault();
  setLoginError("");
  const button = $("#loginSubmit");
  button.disabled = true;
  button.querySelector("b").textContent = "Entrando...";
  try {
    const response = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({
        username: $("#loginUsername").value.trim(),
        password: $("#loginPassword").value,
        remember: $("#rememberLogin").checked
      })
    });
    app.session = { ...app.session, authenticated: true, username: response.username };
    $("#loginPassword").value = "";
    await startApplication();
    if (!hasEnrolledPasskey()) await openBiometricSetup();
  } catch (error) {
    setLoginError(error.message);
    $("#loginPassword").select();
  } finally {
    button.disabled = false;
    button.querySelector("b").textContent = "Entrar no Caption Lab";
  }
}

async function updateBiometricAvailability() {
  const status = $("#biometricDeviceStatus");
  const button = $("#biometricSetupConfirm");
  if (!supabaseClient || !window.PublicKeyCredential || !navigator.credentials) {
    status.classList.add("unavailable");
    status.classList.remove("available");
    $("strong", status).textContent = "Passkeys indisponíveis";
    $("small", status).textContent = "Atualize o navegador ou tente em outro dispositivo.";
    button.disabled = true;
    return false;
  }
  if (!PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable) {
    status.classList.add("available");
    status.classList.remove("unavailable");
    $("strong", status).textContent = "Navegador compatível";
    $("small", status).textContent = "O dispositivo escolherá a forma de proteção disponível.";
    button.disabled = false;
    return true;
  }
  try {
    const available = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    status.classList.add("available");
    status.classList.remove("unavailable");
    $("strong", status).textContent = available ? "Dispositivo compatível" : "Use uma passkey disponível";
    $("small", status).textContent = available ? "Face ID, digital ou proteção de tela detectada." : "Você poderá usar um celular, gerenciador de senhas ou chave de segurança.";
    button.disabled = false;
    return true;
  } catch {
    status.classList.add("unavailable");
    $("strong", status).textContent = "Não foi possível verificar";
    $("small", status).textContent = "Tente novamente em outro navegador ou dispositivo.";
    button.disabled = true;
    return false;
  }
}

async function openBiometricSetup() {
  const message = $("#biometricSetupMessage");
  message.classList.add("hidden");
  message.classList.remove("success");
  elements.biometricModal.classList.remove("hidden");
  await updateBiometricAvailability();
  if (supabaseClient) {
    const { data } = await supabaseClient.auth.getSession();
    if (!data?.session) {
      message.textContent = "Para proteger este acesso, confirme uma vez a Conta Google autorizada. Depois disso, a biometria substituirá a senha neste dispositivo.";
      message.classList.remove("hidden");
      $("#biometricSetupConfirm").textContent = "Continuar com Google";
    }
  }
}

function closeBiometricSetup() {
  elements.biometricModal.classList.add("hidden");
}

async function registerBiometrics() {
  const available = await updateBiometricAvailability();
  if (!available) return;
  const message = $("#biometricSetupMessage");
  const button = $("#biometricSetupConfirm");
  message.classList.add("hidden");
  message.classList.remove("success");
  button.disabled = true;
  button.textContent = "Confirmando...";
  try {
    const { data: sessionData } = await supabaseClient.auth.getSession();
    if (!sessionData?.session) {
      if (!app.session.googleLoginUrl) throw new Error("O login Google ainda não está configurado.");
      sessionStorage.setItem("captionLabGoogleRemember", "1");
      window.location.assign(app.session.googleLoginUrl);
      return;
    }
    const { data, error } = await supabaseClient.auth.registerPasskey();
    if (error) throw error;
    message.textContent = `Passkey cadastrada com sucesso${data?.friendly_name ? `: ${data.friendly_name}` : ""}.`;
    message.classList.add("success");
    message.classList.remove("hidden");
    $("strong", $("#biometricDeviceStatus")).textContent = "Cadastro concluído";
    $("small", $("#biometricDeviceStatus")).textContent = "Você já pode usar a biometria na próxima entrada.";
    localStorage.setItem(PASSKEY_ENROLLED_KEY, "1");
    updatePasskeyLoginAvailability();
  } catch (error) {
    if (String(error?.code || "") === "webauthn_credential_exists") {
      localStorage.setItem(PASSKEY_ENROLLED_KEY, "1");
      updatePasskeyLoginAvailability();
      message.textContent = "A biometria já está cadastrada para esta conta.";
      message.classList.add("success");
      message.classList.remove("hidden");
    } else {
      message.textContent = passkeyErrorMessage(error);
      message.classList.remove("hidden");
    }
  } finally {
    button.disabled = false;
    button.textContent = "Cadastrar neste dispositivo";
  }
}

function passkeyErrorMessage(error) {
  const code = String(error?.code || "");
  const name = String(error?.name || "");
  const message = String(error?.message || error || "");
  if (name === "NotAllowedError" || /not allowed|cancel/i.test(message)) return "A confirmação foi cancelada ou demorou demais. Tente novamente.";
  if (code === "passkey_disabled") return "Ative Passkeys em Authentication → Passkeys no Supabase.";
  if (code === "webauthn_credential_exists") return "Este dispositivo já possui uma passkey cadastrada para esta conta.";
  if (code === "webauthn_credential_not_found") return "Nenhuma passkey cadastrada foi encontrada neste dispositivo.";
  if (/Browser does not support WebAuthn/i.test(message)) return "Este navegador não oferece suporte a passkeys.";
  return message || "Não foi possível concluir a autenticação biométrica.";
}

async function logout() {
  try { await supabaseClient?.auth.signOut({ scope: "local" }); } catch {}
  try { await api("/api/logout", { method: "POST" }); }
  finally { window.location.reload(); }
}

function setLoginError(message) {
  const error = $("#loginError");
  error.textContent = message;
  error.classList.toggle("hidden", !message);
}

async function startApplication() {
  $("#loginScreen").classList.add("hidden");
  document.body.classList.add("authenticated");
  if (app.started) return;
  app.started = true;
  bindNavigation();
  bindComposer();
  bindImport();
  bindLibrary();
  bindUiUtilities();
  await Promise.all([loadHealth(), loadState()]);
  renderAll();
}

async function loadHealth() {
  try {
    app.health = await api("/api/health");
  } catch {
    app.health = { aiConfigured: false, model: "servidor indisponível" };
  }
  renderHealth();
}

async function loadState() {
  try {
    app.state = await api("/api/state");
  } catch (error) {
    toast(error.message, "error");
  }
}

function bindNavigation() {
  $$(".nav-item[data-page]").forEach((button) => button.addEventListener("click", () => navigate(button.dataset.page)));
  $$('[data-go="voice"]').forEach((button) => button.addEventListener("click", () => navigate("voice")));
  $("#mobileMenu").addEventListener("click", () => $(".sidebar").classList.toggle("open"));
}

function navigate(page) {
  const names = { create: "Criar legenda", voice: "Base de voz", learning: "Aprendizados" };
  $$(".page").forEach((item) => item.classList.toggle("active", item.id === `page-${page}`));
  $$(".nav-item[data-page]").forEach((item) => item.classList.toggle("active", item.dataset.page === page));
  $("#breadcrumb").textContent = names[page];
  $(".sidebar").classList.remove("open");
  window.scrollTo({ top: 0, behavior: "smooth" });
  if (page === "voice") renderCorpus();
  if (page === "learning") renderLearning();
}

function bindComposer() {
  elements.brief.addEventListener("input", () => $("#briefCount").textContent = elements.brief.value.length);
  elements.imageInput.addEventListener("change", (event) => handleImage(event.target.files[0]));
  elements.dropZone.addEventListener("dragover", (event) => { event.preventDefault(); elements.dropZone.classList.add("dragging"); });
  elements.dropZone.addEventListener("dragleave", () => elements.dropZone.classList.remove("dragging"));
  elements.dropZone.addEventListener("drop", (event) => {
    event.preventDefault();
    elements.dropZone.classList.remove("dragging");
    handleImage(event.dataTransfer.files[0]);
  });
  $("#removeImage").addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); clearImage(); });
  $$('input[name="unit"]').forEach((input) => input.addEventListener("change", () => {
    $("#topUnit").textContent = selectedUnit();
    renderVoiceCard();
  }));
  elements.form.addEventListener("submit", generateCaptions);
  $("#briefHelper").addEventListener("click", improveBrief);
}

async function handleImage(file) {
  if (!file) return;
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return toast("Use uma imagem JPG, PNG ou WEBP.", "error");
  if (file.size > 8 * 1024 * 1024) return toast("A imagem precisa ter no máximo 8 MB.", "error");
  try {
    const optimized = await optimizeImage(file);
    app.image = optimized;
    $("#previewImg").src = optimized;
    $("#fileName").textContent = file.name;
    $("#fileSize").textContent = `${formatBytes(file.size)} • otimizada para análise`;
    $("#uploadEmpty").classList.add("hidden");
    $("#imagePreview").classList.remove("hidden");
  } catch {
    toast("Não foi possível preparar esta imagem.", "error");
  }
}

function optimizeImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => {
      const image = new Image();
      image.onerror = reject;
      image.onload = () => {
        const maxSide = 1536;
        const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        const context = canvas.getContext("2d");
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", .86));
      };
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function clearImage() {
  app.image = null;
  elements.imageInput.value = "";
  $("#previewImg").removeAttribute("src");
  $("#uploadEmpty").classList.remove("hidden");
  $("#imagePreview").classList.add("hidden");
}

function improveBrief() {
  const value = elements.brief.value.trim();
  if (!value) {
    elements.brief.value = "Tema do post: \nO que aconteceu: \nQuem participou: \nInformações obrigatórias: \nSentimento que queremos transmitir: ";
  } else if (!value.includes("Informações obrigatórias:")) {
    elements.brief.value = `${value}\n\nInformações obrigatórias: \nSentimento que queremos transmitir: `;
  } else {
    toast("Seu briefing já está estruturado.");
  }
  elements.brief.dispatchEvent(new Event("input"));
  elements.brief.focus();
}

async function generateCaptions(event) {
  event.preventDefault();
  const brief = elements.brief.value.trim();
  if (!brief && !app.image) {
    toast("Envie uma imagem ou descreva a ideia do post.", "error");
    elements.brief.focus();
    return;
  }

  setGenerating(true);
  try {
    const response = await api("/api/generate", {
      method: "POST",
      body: JSON.stringify({
        unit: selectedUnit(),
        brief,
        image: app.image,
        contentType: $("#contentType").value,
        goal: $("#goal").value,
        length: $("#length").value,
        emojiLevel: $("#emojiLevel").value,
        cta: $("#cta").value
      })
    });
    app.currentCaptions = response.captions;
    app.state.generations = Number(app.state.generations || 0) + response.captions.length;
    renderResults(response.captions, response.mode);
    renderStats();
    elements.results.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    toast(error.message, "error");
  } finally {
    setGenerating(false);
  }
}

function setGenerating(active) {
  elements.generateButton.disabled = active;
  elements.generateButton.querySelector("b").textContent = active ? (app.health.aiConfigured ? "Analisando e escrevendo..." : "Criando opções...") : "Gerar legendas";
  elements.generateButton.querySelector("span").textContent = active ? "◌" : "✦";
}

function renderResults(captions, mode) {
  $("#modePill").textContent = mode === "ai" ? `${app.health.provider || "IA"} • ${app.health.model}` : "Modo demonstração";
  elements.resultsGrid.innerHTML = captions.map((caption, index) => `
    <article class="result-card" data-id="${escapeHtml(caption.id)}">
      <div class="result-top"><div class="result-label"><i></i><span>OPÇÃO ${index + 1} · ${escapeHtml(caption.label)}</span></div><span class="result-count">${caption.text.length} caracteres</span></div>
      <textarea class="result-text" aria-label="Legenda ${index + 1}">${escapeHtml(caption.text)}</textarea>
      <div class="result-strategy">✦ ${escapeHtml(caption.strategy)}</div>
      <div class="result-actions">
        <button class="action-btn like" title="Gostei" aria-label="Gostei">♡</button>
        <button class="action-btn dislike" title="Não gostei" aria-label="Não gostei">×</button>
        <button class="action-btn copy-btn"><span>▣</span> Copiar</button>
      </div>
    </article>`).join("");

  $$(".result-card", elements.resultsGrid).forEach((card) => {
    const textarea = $(".result-text", card);
    textarea.addEventListener("input", () => $(".result-count", card).textContent = `${textarea.value.length} caracteres`);
    $(".copy-btn", card).addEventListener("click", () => copyCaption(card));
    $(".like", card).addEventListener("click", () => rateCaption(card, "like"));
    $(".dislike", card).addEventListener("click", () => rateCaption(card, "dislike"));
  });
  elements.results.classList.remove("hidden");
}

async function copyCaption(card) {
  const button = $(".copy-btn", card);
  try {
    await navigator.clipboard.writeText($(".result-text", card).value);
    button.innerHTML = "✓ Copiada";
    button.classList.add("copied");
    setTimeout(() => { button.innerHTML = "<span>▣</span> Copiar"; button.classList.remove("copied"); }, 1800);
  } catch {
    $(".result-text", card).select();
    document.execCommand("copy");
    toast("Legenda copiada.");
  }
}

async function rateCaption(card, rating) {
  const existing = app.state.feedback.find((item) => item.generationId === card.dataset.id);
  if (existing?.rating === rating) return;
  let reason = "";
  if (rating === "dislike") {
    reason = window.prompt("O que não funcionou? (opcional)", "") || "";
  }
  try {
    const response = await api("/api/feedback", {
      method: "POST",
      body: JSON.stringify({ generationId: card.dataset.id, rating, unit: selectedUnit(), caption: $(".result-text", card).value, reason })
    });
    app.state = response.state;
    $(".like", card).classList.toggle("active", rating === "like");
    $(".dislike", card).classList.toggle("active", rating === "dislike");
    renderStats();
    renderLearning();
    toast(rating === "like" ? "Boa! Essa preferência foi salva." : "Entendido. Vamos evitar esse caminho.");
  } catch (error) {
    toast(error.message, "error");
  }
}

function bindImport() {
  $("#openImport").addEventListener("click", openImport);
  $$('[data-open-import]').forEach((button) => button.addEventListener("click", openImport));
  $("#closeImport").addEventListener("click", closeImport);
  $("#cancelImport").addEventListener("click", closeImport);
  $$("[data-import-unit]").forEach((button) => button.addEventListener("click", () => {
    app.importUnit = button.dataset.importUnit;
    $$("[data-import-unit]").forEach((item) => item.classList.toggle("active", item === button));
  }));
  $("#corpusFile").addEventListener("change", readCorpusFile);
  $("#saveImport").addEventListener("click", saveCorpus);
  elements.importModal.addEventListener("click", (event) => { if (event.target === elements.importModal) closeImport(); });
  $("#openInstagram").addEventListener("click", openInstagram);
  $("#closeInstagram").addEventListener("click", closeInstagram);
  $("#cancelInstagram").addEventListener("click", closeInstagram);
  elements.instagramModal.addEventListener("click", (event) => { if (event.target === elements.instagramModal) closeInstagram(); });
  $$('[data-instagram-unit]').forEach((button) => button.addEventListener("click", () => {
    app.instagramUnit = button.dataset.instagramUnit;
    $$('[data-instagram-unit]').forEach((item) => item.classList.toggle("active", item === button));
    renderInstagramConnection();
  }));
  $$('[data-instagram-method]').forEach((button) => button.addEventListener("click", () => {
    app.instagramMethod = button.dataset.instagramMethod;
    $$('[data-instagram-method]').forEach((item) => item.classList.toggle("active", item === button));
    renderInstagramMethod();
  }));
  $("#instagramPostLinks").addEventListener("input", () => {
    $("#instagramLinksCount").textContent = getInstagramLinks().length;
  });
  $("#syncInstagram").addEventListener("click", syncInstagram);
  $("#instagramStartMonth").max = new Date().toISOString().slice(0, 7);
}

function openImport() { elements.importModal.classList.remove("hidden"); }
function closeImport() { elements.importModal.classList.add("hidden"); }

function openInstagram() {
  renderInstagramMethod();
  renderInstagramConnection();
  elements.instagramModal.classList.remove("hidden");
}

function closeInstagram() { elements.instagramModal.classList.add("hidden"); }

function renderInstagramConnection() {
  if (app.instagramMethod === "links") {
    const box = $("#instagramConnection");
    box.classList.add("connected");
    $("strong", box).textContent = "Modo gratuito por links";
    $("small", box).textContent = "Sem conta externa e sem token";
    return;
  }
  const configured = Boolean(app.health.instagramConfigured?.[app.instagramUnit]);
  const box = $("#instagramConnection");
  box.classList.toggle("connected", configured);
  const provider = app.health.instagramProvider;
  $("strong", box).textContent = configured ? `${provider || "Instagram"} pronta para ${app.instagramUnit}` : "Coleta pública ainda não configurada";
  $("small", box).textContent = configured ? "Pronto para ler de agosto de 2024 até hoje" : "Cadastre APIFY_API_TOKEN na hospedagem";
}

function renderInstagramMethod() {
  const byLinks = app.instagramMethod === "links";
  $("#instagramLinksPanel").classList.toggle("hidden", !byLinks);
  $("#instagramProfilePanel").classList.toggle("hidden", byLinks);
  $("#instagramMethodHelp").textContent = byLinks
    ? "O modo por links usa um leitor público gratuito, sem conta ou token. O progresso é salvo a cada publicação."
    : "O perfil completo exige APIFY_API_TOKEN ou autorização oficial da Meta.";
  $("#syncInstagram").textContent = byLinks ? "Importar links gratuitamente" : "Ler perfil até hoje";
  renderInstagramConnection();
}

function getInstagramLinks() {
  return [...new Set($("#instagramPostLinks").value.split(/\s+/).map((item) => item.trim()).filter((item) => /instagram\.com\/(p|reel|tv)\//i.test(item)))];
}

async function syncInstagram() {
  const profileUrl = $("#instagramProfileUrl").value.trim();
  const links = getInstagramLinks();
  if (app.instagramMethod === "profile" && !profileUrl) return toast("Cole o link do perfil do Instagram.", "error");
  if (app.instagramMethod === "links" && !links.length) return toast("Cole pelo menos um link de publicação.", "error");
  const button = $("#syncInstagram");
  const progress = $("#instagramProgress");
  const progressBar = $("#instagramProgressBar");
  const progressText = $("#instagramProgressText");
  button.disabled = true;
  button.textContent = app.instagramMethod === "links" ? `Lendo 0/${links.length}...` : "Lendo publicações...";
  try {
    const startDate = `${$("#instagramStartMonth").value}-01`;
    let response;
    let added = 0;
    let scanned = 0;
    let failures = [];

    if (app.instagramMethod === "links") {
      const batchSize = 1;
      progress.classList.remove("hidden");
      progressBar.style.width = "0%";
      const estimatedMinutes = Math.max(1, Math.ceil(links.length / 20));
      progressText.textContent = `Iniciando ${links.length} links · modo gratuito: cerca de ${estimatedMinutes} min`;

      for (let index = 0; index < links.length; index += batchSize) {
        const batch = links.slice(index, index + batchSize);
        response = await api("/api/instagram/links", {
          method: "POST",
          body: JSON.stringify({ unit: app.instagramUnit, links: batch, startDate })
        });
        app.state = response.state;
        added += response.added || 0;
        scanned += response.scanned || batch.length;
        failures = failures.concat(response.failures || []);

        const completed = Math.min(index + batch.length, links.length);
        const percentage = Math.round((completed / links.length) * 100);
        progressBar.style.width = `${percentage}%`;
        progressText.textContent = `${completed} de ${links.length} links verificados · ${added} legendas adicionadas`;
        button.textContent = `Lendo ${completed}/${links.length}...`;
      }
    } else {
      response = await api("/api/instagram/import", {
        method: "POST",
        body: JSON.stringify({ unit: app.instagramUnit, profileUrl, startDate })
      });
      app.state = response.state;
      added = response.added || 0;
      scanned = response.scanned || 0;
      failures = response.failures || [];
    }

    closeInstagram();
    renderAll();
    const source = response.username ? ` de @${response.username}` : "";
    const failureMessage = failures.length ? ` ${failures.length} link${failures.length === 1 ? " falhou" : "s falharam"}.` : "";
    toast(`${added} legenda${added === 1 ? " adicionada" : "s adicionadas"}${source}. ${scanned} publicações verificadas.${failureMessage}`);
  } catch (error) {
    renderAll();
    if (app.instagramMethod === "links") progressText.textContent = "A importação foi interrompida. As legendas dos lotes concluídos foram salvas.";
    toast(error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = app.instagramMethod === "links" ? "Importar links gratuitamente" : "Ler perfil até hoje";
  }
}

async function readCorpusFile(event) {
  const file = event.target.files[0];
  if (!file) return;
  const text = await file.text();
  let captions;
  if (file.name.toLowerCase().endsWith(".csv")) captions = extractCaptionsFromCsv(text);
  else captions = splitCaptionBlocks(text);
  $("#manualCorpus").value = captions.join("\n\n");
  toast(`${captions.length} legenda${captions.length === 1 ? "" : "s"} encontrada${captions.length === 1 ? "" : "s"} no arquivo.`);
}

function extractCaptionsFromCsv(text) {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const header = rows[0].map((cell) => normalizeText(cell));
  const candidates = ["legenda", "caption", "texto", "copy", "description", "descricao"];
  let index = header.findIndex((cell) => candidates.includes(cell));
  if (index < 0) index = rows[0].length === 1 ? 0 : rows[0].reduce((best, _, idx) => averageCellLength(rows.slice(1), idx) > averageCellLength(rows.slice(1), best) ? idx : best, 0);
  const start = header.some((cell) => candidates.includes(cell)) ? 1 : 0;
  return rows.slice(start).map((row) => (row[index] || "").trim()).filter((value) => value.length > 10);
}

function parseCsv(text) {
  const delimiter = (text.split("\n")[0].match(/;/g) || []).length > (text.split("\n")[0].match(/,/g) || []).length ? ";" : ",";
  const rows = []; let row = []; let cell = ""; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"' && quoted && text[i + 1] === '"') { cell += '"'; i++; }
    else if (char === '"') quoted = !quoted;
    else if (char === delimiter && !quoted) { row.push(cell); cell = ""; }
    else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); if (row.some((value) => value.trim())) rows.push(row); row = []; cell = "";
    } else cell += char;
  }
  row.push(cell); if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}

function averageCellLength(rows, index) {
  if (!rows.length) return 0;
  return rows.reduce((sum, row) => sum + (row[index] || "").length, 0) / rows.length;
}

function splitCaptionBlocks(text) {
  const blocks = text.split(/\r?\n\s*\r?\n+/).map((item) => item.trim()).filter((item) => item.length > 10);
  if (blocks.length > 1) return blocks;
  return text.split(/\r?\n/).map((item) => item.trim()).filter((item) => item.length > 10);
}

async function saveCorpus() {
  const captions = splitCaptionBlocks($("#manualCorpus").value);
  if (!captions.length) return toast("Cole ou selecione pelo menos uma legenda.", "error");
  const button = $("#saveImport"); button.disabled = true; button.textContent = "Adicionando...";
  try {
    const response = await api("/api/corpus", {
      method: "POST",
      body: JSON.stringify({ items: captions.map((caption) => ({ unit: app.importUnit, caption, source: "Importação" })) })
    });
    app.state = response.state;
    $("#manualCorpus").value = "";
    $("#corpusFile").value = "";
    closeImport();
    renderAll();
    toast(`${response.added} legenda${response.added === 1 ? " adicionada" : "s adicionadas"} à voz de ${app.importUnit}.`);
  } catch (error) { toast(error.message, "error"); }
  finally { button.disabled = false; button.textContent = "Adicionar à base"; }
}

function bindLibrary() {
  $("#corpusSearch").addEventListener("input", renderCorpus);
  $$("[data-filter]").forEach((button) => button.addEventListener("click", () => {
    app.corpusFilter = button.dataset.filter;
    $$("[data-filter]").forEach((item) => item.classList.toggle("active", item === button));
    renderCorpus();
  }));
}

function renderCorpus() {
  const search = normalizeText($("#corpusSearch").value);
  const filtered = app.state.corpus.filter((item) => {
    const unitMatch = app.corpusFilter === "Todas" || item.unit === app.corpusFilter;
    return unitMatch && (!search || normalizeText(item.caption).includes(search));
  });
  $("#corpusList").innerHTML = filtered.map((item) => `
    <article class="corpus-item" data-id="${escapeHtml(item.id)}">
      <span class="corpus-unit ${item.unit === "Linhares" ? "linhares" : ""}">${escapeHtml(item.unit)}</span>
      <div class="corpus-copy"><p>${escapeHtml(item.caption)}</p><small>${escapeHtml(item.source || "Manual")} • ${item.caption.length} caracteres</small></div>
      <button class="delete-item" aria-label="Excluir legenda" title="Excluir">×</button>
    </article>`).join("");
  $("#corpusEmpty").classList.toggle("hidden", filtered.length > 0 || app.state.corpus.length > 0);
  if (!filtered.length && app.state.corpus.length > 0) $("#corpusList").innerHTML = '<div class="empty-state"><p>Nenhuma legenda encontrada neste filtro.</p></div>';
  $$(".delete-item", $("#corpusList")).forEach((button) => button.addEventListener("click", () => deleteCorpus(button.closest(".corpus-item").dataset.id)));
}

async function deleteCorpus(id) {
  try {
    const response = await api(`/api/corpus/${encodeURIComponent(id)}`, { method: "DELETE" });
    app.state = response.state;
    renderAll();
    toast("Legenda removida da base.");
  } catch (error) { toast(error.message, "error"); }
}

function bindUiUtilities() {
  $("#helpButton").addEventListener("click", () => elements.helpModal.classList.remove("hidden"));
  $$('[data-close-help]').forEach((button) => button.addEventListener("click", () => elements.helpModal.classList.add("hidden")));
  elements.helpModal.addEventListener("click", (event) => { if (event.target === elements.helpModal) elements.helpModal.classList.add("hidden"); });
  $("#biometricSetupButton").addEventListener("click", openBiometricSetup);
  $("#biometricSetupConfirm").addEventListener("click", registerBiometrics);
  $$('[data-close-biometric]').forEach((button) => button.addEventListener("click", closeBiometricSetup));
  elements.biometricModal.addEventListener("click", (event) => { if (event.target === elements.biometricModal) closeBiometricSetup(); });
  $("#themeButton").addEventListener("click", () => {
    document.body.classList.toggle("dark");
    localStorage.setItem("caption-lab-theme", document.body.classList.contains("dark") ? "dark" : "light");
  });
  if (localStorage.getItem("caption-lab-theme") === "dark") document.body.classList.add("dark");
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { closeImport(); closeInstagram(); closeBiometricSetup(); elements.helpModal.classList.add("hidden"); }
  });
}

function renderAll() {
  renderStats();
  renderVoiceCard();
  renderCorpus();
  renderLearning();
}

function renderHealth() {
  const status = $("#aiStatus");
  status.classList.toggle("connected", app.health.aiConfigured);
  $("strong", status).textContent = app.health.aiConfigured ? "IA conectada" : "Modo demonstração";
  $("small", status).textContent = app.health.aiConfigured ? `${app.health.provider || "IA"} • ${app.health.model}` : "Configure a chave para analisar imagens";
}

function renderStats() {
  const colatina = app.state.corpus.filter((item) => item.unit === "Colatina").length;
  const linhares = app.state.corpus.filter((item) => item.unit === "Linhares").length;
  $("#generationCount").textContent = Number(app.state.generations || 0).toLocaleString("pt-BR");
  $("#corpusBadge").textContent = app.state.corpus.length;
  $("#colatinaCount").textContent = `${colatina} referência${colatina === 1 ? "" : "s"}`;
  $("#linharesCount").textContent = `${linhares} referência${linhares === 1 ? "" : "s"}`;
  $("#totalCorpus").textContent = app.state.corpus.length;
  $("#voiceColatina").textContent = colatina;
  $("#voiceLinhares").textContent = linhares;
  const avg = app.state.corpus.length ? Math.round(app.state.corpus.reduce((sum, item) => sum + item.caption.length, 0) / app.state.corpus.length) : 0;
  $("#avgLength").textContent = avg;
  const feedbackCount = app.state.feedback.length;
  $("#memoryCount").textContent = feedbackCount ? `${feedbackCount} avaliação${feedbackCount === 1 ? "" : "ões"} registrada${feedbackCount === 1 ? "" : "s"}` : "Nenhum feedback ainda";
  $("#memoryBar").style.width = `${Math.min(100, feedbackCount * 8)}%`;
}

function renderVoiceCard() {
  const unit = selectedUnit();
  const total = app.state.corpus.filter((item) => item.unit === unit).length;
  const score = Math.min(100, 22 + total * 3);
  $("#voiceUnit").textContent = `Darwin ${unit}`;
  $("#voiceScore").textContent = `${score}%`;
  $(".voice-orbit").style.setProperty("--score", `${score}%`);
  $("#voiceMessage").textContent = total >= 20 ? `A base de ${unit} já tem material para reconhecer padrões consistentes.` : `Adicione mais ${Math.max(0, 20 - total)} legendas de ${unit} para fortalecer a leitura do tom.`;
}

function renderLearning() {
  const likes = app.state.feedback.filter((item) => item.rating === "like").length;
  const dislikes = app.state.feedback.filter((item) => item.rating === "dislike").length;
  const total = likes + dislikes;
  const rate = total ? Math.round(likes / total * 100) : 0;
  $("#likesCount").textContent = likes;
  $("#dislikesCount").textContent = dislikes;
  $("#approvalRate").textContent = total ? `${rate}%` : "—";
  $("#approvalBar").style.width = `${rate}%`;
  $("#feedbackList").innerHTML = app.state.feedback.length ? app.state.feedback.slice(0, 12).map((item) => `
    <article class="feedback-item"><span class="feedback-rating ${item.rating}">${item.rating === "like" ? "♥" : "×"}</span><div class="feedback-copy"><p>${escapeHtml(item.caption)}</p><small>${escapeHtml(item.unit)}${item.reason ? ` • ${escapeHtml(item.reason)}` : ""}</small></div><small>${relativeDate(item.createdAt)}</small></article>`).join("") : '<div class="empty-state"><div>♡</div><h3>Nenhuma avaliação ainda</h3><p>Gere legendas e use os botões de like ou dislike.</p></div>';

  const likedTexts = app.state.feedback.filter((item) => item.rating === "like").map((item) => item.caption);
  const emojiRate = likedTexts.length ? Math.round(likedTexts.filter((text) => /[\p{Extended_Pictographic}]/u.test(text)).length / likedTexts.length * 100) : 0;
  const avgLiked = likedTexts.length ? Math.round(likedTexts.reduce((sum, text) => sum + text.length, 0) / likedTexts.length) : 0;
  const strongestUnit = unitPreference();
  $("#signalsList").innerHTML = [
    ["Uso de emojis", likedTexts.length ? `${emojiRate}% das aprovadas usam emojis` : "Aguardando avaliações"],
    ["Tamanho preferido", avgLiked ? `${avgLiked} caracteres em média` : "Aguardando avaliações"],
    ["Maior aprendizado", strongestUnit ? `Mais sinais em ${strongestUnit}` : "Equilibrado entre unidades"]
  ].map(([title, description], index) => `<div class="signal"><div class="signal-top"><span>${["✦", "⌁", "↗"][index]} ${title}</span></div><p>${description}</p></div>`).join("");
}

function unitPreference() {
  const counts = { Colatina: 0, Linhares: 0 };
  app.state.feedback.forEach((item) => counts[item.unit]++);
  if (counts.Colatina === counts.Linhares) return "";
  return counts.Colatina > counts.Linhares ? "Colatina" : "Linhares";
}

function selectedUnit() { return $('input[name="unit"]:checked').value; }
function formatBytes(bytes) { return bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`; }
function normalizeText(value) { return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim(); }
function relativeDate(value) { const days = Math.floor((Date.now() - new Date(value).getTime()) / 86400000); return days <= 0 ? "hoje" : days === 1 ? "ontem" : `${days}d`; }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char])); }

async function api(path, options = {}) {
  const response = await fetch(path, { headers: { "Content-Type": "application/json", ...(options.headers || {}) }, ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Não foi possível concluir a solicitação.");
  return data;
}

function toast(message, type = "success") {
  const item = document.createElement("div");
  item.className = `toast ${type}`;
  item.textContent = message;
  $("#toastStack").append(item);
  setTimeout(() => item.remove(), 3600);
}
