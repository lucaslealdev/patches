// ---------------------------------------------------------------------------
// Configuração
const API = location.hostname === "localhost" || location.hostname === "127.0.0.1"
  ? "http://localhost:8787"
  : "https://lucaspatcher.lucasleal.workers.dev";
// Site key do Cloudflare Turnstile (vazio = desativado). Em localhost usa a chave de teste oficial, que sempre passa.
const TURNSTILE_SITEKEY = location.hostname === "localhost" || location.hostname === "127.0.0.1"
  ? "1x00000000000000000000AA"
  : "0x4AAAAAAFBQHok785riSpYR";
const VALORES_SUGERIDOS = [100, 200, 500, 1000]; // em centavos
// ---------------------------------------------------------------------------

const $ = (sel, raiz = document) => raiz.querySelector(sel);
const modal = $("#modal");
const conteudo = $("#modal-conteudo");

let patches = [];
let saldo = { saldo_centavos: 0, downloads_gratis: 0, preco_centavos: 100 };
let polling = null;

const reais = (c) => (c / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

// Pequeno armazenamento local para retomar um Pix pendente ou baixar de novo.
const guardado = {
  ler(patch) {
    try { return JSON.parse(localStorage.getItem(`pix:${patch}`)); } catch { return null; }
  },
  gravar(patch, dados) {
    try { localStorage.setItem(`pix:${patch}`, JSON.stringify(dados)); } catch {}
  },
  apagar(patch) {
    try { localStorage.removeItem(`pix:${patch}`); } catch {}
  },
};

async function api(caminho, opcoes = {}) {
  const resp = await fetch(API + caminho, {
    ...opcoes,
    headers: opcoes.body ? { "Content-Type": "application/json" } : undefined,
  });
  const dados = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(dados.erro || "Falha de comunicação. Tente de novo.");
  return dados;
}

// ---------------------------------------------------------------------------
// Lista de patches

async function iniciar() {
  try {
    patches = await (await fetch("patches.json", { cache: "no-cache" })).json();
  } catch {
    $("#lista").innerHTML = `<p class="erro">Não foi possível carregar os patches.</p>`;
    return;
  }
  renderizarLista();
  await atualizarSaldo();

  const hash = location.hash.slice(1);
  if (patches.some((p) => p.id === hash)) abrirPatch(hash);
}

function renderizarLista() {
  const lista = $("#lista");
  lista.textContent = "";
  const tpl = $("#tpl-card");
  for (const p of patches) {
    const card = tpl.content.cloneNode(true);
    const img = $(".capa", card);
    if (p.imagem) img.src = p.imagem;
    else img.remove();
    $(".nome", card).textContent = p.nome;
    $(".jogo", card).textContent = p.versao ? `${p.jogo} · v${p.versao}` : p.jogo;
    $(".resumo", card).textContent = p.resumo;
    if (emDesenvolvimento(p)) {
      $(".card", card).classList.add("em-dev");
      $(".btn-detalhes", card).replaceWith(Object.assign(document.createElement("span"), {
        className: "selo", textContent: "🚧 Em desenvolvimento",
      }));
    } else {
      $(".btn-detalhes", card).addEventListener("click", () => abrirPatch(p.id));
    }
    lista.append(card);
  }
}

async function atualizarSaldo() {
  try {
    saldo = await api("/api/saldo");
  } catch {
    return;
  }
  const el = $("#saldo");
  const n = saldo.downloads_gratis;
  el.hidden = false;
  el.classList.toggle("tem", n > 0);
  el.textContent = n > 0
    ? `🎁 ${n} download${n > 1 ? "s" : ""} cortesia disponíve${n > 1 ? "is" : "l"}, graças a quem contribuiu a mais`
    : "Nenhum download cortesia no momento. Contribua com mais de R$ 1 para liberar downloads para os próximos!";
}

// ---------------------------------------------------------------------------
// Modal do patch

function abrirPatch(id) {
  const p = patches.find((x) => x.id === id);
  if (!p || emDesenvolvimento(p)) return;
  history.replaceState(null, "", `#${id}`);

  conteudo.innerHTML = `
    <h2>${esc(p.nome)}</h2>
    <p class="jogo">${esc(p.jogo)} · v${esc(p.versao)}</p>
    ${p.imagem ? `<img class="capa-grande" src="${esc(p.imagem)}" alt="">` : ""}
    ${(p.detalhes || []).map((t) => `<p>${esc(t)}</p>`).join("")}
    ${p.nota ? `<p class="nota"><strong>⚠️ Nota:</strong> ${esc(p.nota)}</p>` : ""}
    ${p.mudancas?.length ? `<h3>O que muda</h3><ul>${p.mudancas.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : ""}
    ${p.rom ? `
      <h3>ROM necessária</h3>
      <dl class="rom">
        <dt>Arquivo</dt><dd>${esc(p.rom.nome)}</dd>
        ${p.rom.crc32 ? `<dt>CRC32</dt><dd><code>${esc(p.rom.crc32)}</code></dd>` : ""}
        ${p.rom.sha1 ? `<dt>SHA-1</dt><dd><code>${esc(p.rom.sha1)}</code></dd>` : ""}
      </dl>` : ""}
    <section id="checkout" class="checkout"></section>
  `;
  modal.showModal();
  mostrarCheckout(p);
  atualizarSaldo().then(() => {
    // Atualiza a opção de cortesia se o saldo mudou enquanto a modal abria.
    if (modal.open && $("#checkout")?.dataset.estado === "escolha") mostrarCheckout(p);
  });
}

modal.addEventListener("close", () => {
  pararPolling();
  history.replaceState(null, "", location.pathname);
});
modal.addEventListener("click", (e) => {
  if (e.target === modal) modal.close();
});

function mostrarCheckout(p) {
  const anterior = guardado.ler(p.id);
  if (anterior?.id) {
    if (anterior.pago) return mostrarJaPago(p, anterior);
    if (anterior.expira_em > Date.now()) return mostrarPix(p, anterior);
    guardado.apagar(p.id);
  }
  mostrarEscolha(p);
}

function mostrarEscolha(p) {
  const box = $("#checkout");
  box.dataset.estado = "escolha";
  const temCortesia = saldo.downloads_gratis > 0;

  box.innerHTML = `
    ${temCortesia ? `
      <div class="cortesia">
        <p>🎁 Há <strong>${saldo.downloads_gratis}</strong> download${saldo.downloads_gratis > 1 ? "s" : ""}
          cortesia disponíve${saldo.downloads_gratis > 1 ? "is" : "l"}, pago${saldo.downloads_gratis > 1 ? "s" : ""} por quem contribuiu a mais.</p>
        <div id="turnstile-widget"></div>
        <button class="btn btn-primario" id="btn-gratis" type="button">Baixar grátis</button>
      </div>
      <p class="ou">ou contribua você também:</p>` : `<h3>Contribua e baixe</h3>`}
    <div class="valores" role="radiogroup" aria-label="Valor da contribuição">
      ${VALORES_SUGERIDOS.map((v, i) => `
        <label class="chip"><input type="radio" name="valor" value="${v}" ${i === 0 ? "checked" : ""}><span>${reais(v)}</span></label>`).join("")}
      <label class="chip outro">
        <input type="radio" name="valor" value="outro"><span>Outro</span>
      </label>
    </div>
    <div class="valor-outro" hidden>
      <label>R$ <input type="number" id="valor-livre" min="1" step="0.01" inputmode="decimal" placeholder="1,00"></label>
    </div>
    <p class="explica" id="explica"></p>
    <button class="btn ${temCortesia ? "" : "btn-primario"}" id="btn-pix" type="button">Gerar Pix</button>
    <p class="msg" id="msg" role="alert"></p>
  `;

  const atualizarExplica = () => {
    const v = valorEscolhido();
    const el = $("#explica");
    if (!v || v < saldo.preco_centavos) {
      el.textContent = `Valor mínimo: ${reais(saldo.preco_centavos)}.`;
      return;
    }
    const excedente = v - saldo.preco_centavos;
    const libera = Math.floor(excedente / saldo.preco_centavos);
    el.innerHTML = excedente === 0
      ? `${reais(v)} paga o seu download.`
      : `${reais(saldo.preco_centavos)} paga o seu download e <strong>${reais(excedente)}</strong> vai para o saldo de cortesia` +
        (libera > 0 ? `, liberando <strong>${libera}</strong> download${libera > 1 ? "s" : ""} grátis para os próximos. 💛` : ". 💛");
  };

  // onchange (e não addEventListener) porque a caixa é reaproveitada a cada renderização.
  box.onchange = (e) => {
    if (e.target.name === "valor") {
      const outro = e.target.value === "outro";
      $(".valor-outro", box).hidden = !outro;
      if (outro) $("#valor-livre").focus();
    }
    atualizarExplica();
  };
  $("#valor-livre").addEventListener("input", atualizarExplica);
  atualizarExplica();

  $("#btn-pix").addEventListener("click", () => gerarPix(p));
  if (temCortesia) {
    renderizarTurnstile();
    $("#btn-gratis").addEventListener("click", () => baixarGratis(p));
  }
}

function valorEscolhido() {
  const sel = $('input[name="valor"]:checked');
  if (!sel) return 0;
  if (sel.value !== "outro") return Number(sel.value);
  const bruto = String($("#valor-livre").value).replace(",", ".");
  return Math.round(Number(bruto) * 100) || 0;
}

async function gerarPix(p) {
  const valor = valorEscolhido();
  const msg = $("#msg");
  if (valor < saldo.preco_centavos) {
    msg.textContent = `O valor mínimo é ${reais(saldo.preco_centavos)}.`;
    return;
  }
  const btn = $("#btn-pix");
  btn.disabled = true;
  btn.textContent = "Gerando Pix…";
  try {
    const pix = await api("/api/pagar", { method: "POST", body: JSON.stringify({ patch: p.id, valor_centavos: valor }) });
    const dados = { ...pix, valor };
    guardado.gravar(p.id, dados);
    mostrarPix(p, dados);
  } catch (err) {
    msg.textContent = err.message;
    btn.disabled = false;
    btn.textContent = "Gerar Pix";
  }
}

function mostrarPix(p, pix) {
  const box = $("#checkout");
  box.dataset.estado = "pix";
  box.innerHTML = `
    <h3>Pague ${pix.valor ? reais(pix.valor) : ""} com Pix</h3>
    ${pix.qr_code_base64 ? `<img class="qr" src="data:image/png;base64,${pix.qr_code_base64}" alt="QR code Pix">` : ""}
    <label class="copia-cola">Pix copia e cola
      <textarea readonly rows="3">${esc(pix.qr_code || "")}</textarea>
    </label>
    <button class="btn" id="btn-copiar" type="button">Copiar código</button>
    <p class="aguardando"><span class="spinner" aria-hidden="true"></span> Aguardando pagamento… <span id="contagem"></span></p>
    ${pix.teste ? `<button class="btn btn-teste" id="btn-simular" type="button">⚙️ Simular pagamento (modo teste)</button>` : ""}
    <button class="btn-link" id="btn-cancelar" type="button">Escolher outro valor</button>
    <p class="msg" id="msg" role="alert"></p>
  `;

  $("#btn-copiar").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(pix.qr_code);
      $("#btn-copiar").textContent = "Copiado!";
    } catch {
      $("textarea", box).select();
    }
  });
  $("#btn-cancelar").addEventListener("click", () => {
    pararPolling();
    guardado.apagar(p.id);
    mostrarEscolha(p);
  });
  $("#btn-simular")?.addEventListener("click", () => api(`/api/teste/aprovar/${pix.id}`, { method: "POST" }));

  pararPolling();
  const verificar = async () => {
    const restante = pix.expira_em - Date.now();
    const contagem = $("#contagem");
    if (contagem) {
      const m = Math.max(0, Math.floor(restante / 60000));
      const s = Math.max(0, Math.floor((restante % 60000) / 1000));
      contagem.textContent = `(expira em ${m}:${String(s).padStart(2, "0")})`;
    }
    try {
      const st = await api(`/api/pagamento/${pix.id}`);
      if (st.status === "approved") {
        pararPolling();
        guardado.gravar(p.id, { id: pix.id, pago: true });
        mostrarPago(p, st.download_url, pix.valor);
        atualizarSaldo();
      } else if (st.status !== "pending") {
        pararPolling();
        guardado.apagar(p.id);
        mostrarEscolha(p);
        $("#msg").textContent = "O Pix expirou ou foi cancelado. Gere um novo.";
      }
    } catch {
      // Falha de rede momentânea: tenta de novo no próximo ciclo.
    }
  };
  verificar();
  polling = setInterval(verificar, 3000);
}

function pararPolling() {
  if (polling) clearInterval(polling);
  polling = null;
}

function mostrarPago(p, url, valor) {
  const box = $("#checkout");
  box.dataset.estado = "pago";
  const extra = valor ? valor - saldo.preco_centavos : 0;
  box.innerHTML = `
    <div class="sucesso">
      <h3>✅ Pagamento confirmado. Obrigado!</h3>
      ${extra > 0 ? `<p>Seus ${reais(extra)} a mais foram para o saldo de cortesia. Valeu demais! 💛</p>` : ""}
      <p>O download deve começar sozinho. Se não começar:</p>
      <a class="btn btn-primario" href="${esc(url)}">Baixar ${esc(p.id)}.bps</a>
    </div>
  `;
  location.href = url;
}

function mostrarJaPago(p, anterior) {
  const box = $("#checkout");
  box.dataset.estado = "ja-pago";
  box.innerHTML = `
    <div class="sucesso">
      <p>Você já contribuiu por este patch neste navegador. 💛</p>
      <button class="btn btn-primario" id="btn-rebaixar" type="button">Baixar novamente</button>
      <button class="btn-link" id="btn-novo" type="button">Contribuir de novo</button>
      <p class="msg" id="msg" role="alert"></p>
    </div>
  `;
  $("#btn-rebaixar").addEventListener("click", async () => {
    try {
      const st = await api(`/api/pagamento/${anterior.id}`);
      if (st.download_url) location.href = st.download_url;
      else throw new Error("Não foi possível recuperar o download.");
    } catch (err) {
      $("#msg").textContent = err.message;
    }
  });
  $("#btn-novo").addEventListener("click", () => {
    guardado.apagar(p.id);
    mostrarEscolha(p);
  });
}

// ---------------------------------------------------------------------------
// Download cortesia

let turnstileId = null;
let turnstileCarregando = null;

function carregarTurnstile() {
  if (!TURNSTILE_SITEKEY) return Promise.resolve(null);
  // Checa a função, não só a variável: um elemento com id="turnstile" também viraria window.turnstile.
  if (typeof window.turnstile?.render === "function") return Promise.resolve(window.turnstile);
  turnstileCarregando ??= new Promise((ok, falha) => {
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    s.async = true;
    s.onload = () => ok(window.turnstile);
    s.onerror = falha;
    document.head.append(s);
  });
  return turnstileCarregando;
}

async function renderizarTurnstile() {
  const ts = await carregarTurnstile().catch(() => null);
  const alvo = $("#turnstile-widget");
  if (!ts || !alvo) return;
  turnstileId = ts.render(alvo, { sitekey: TURNSTILE_SITEKEY, language: "pt-br", size: "flexible" });
}

async function baixarGratis(p) {
  const btn = $("#btn-gratis");
  const msg = $("#msg");
  let token = "";
  if (TURNSTILE_SITEKEY) {
    token = window.turnstile?.getResponse(turnstileId) || "";
    if (!token) {
      msg.textContent = "Aguarde a verificação anti-robô terminar.";
      return;
    }
  }
  btn.disabled = true;
  btn.textContent = "Liberando…";
  try {
    const r = await api("/api/gratis", { method: "POST", body: JSON.stringify({ patch: p.id, turnstile: token }) });
    const box = $("#checkout");
    box.dataset.estado = "pago";
    box.innerHTML = `
      <div class="sucesso">
        <h3>🎁 Download cortesia liberado!</h3>
        <p>Alguém pagou a mais para que você pudesse baixar. Se curtir o patch, considere contribuir para o próximo. 💛</p>
        <a class="btn btn-primario" href="${esc(r.download_url)}">Baixar ${esc(p.id)}.bps</a>
      </div>
    `;
    location.href = r.download_url;
  } catch (err) {
    msg.textContent = err.message;
    btn.disabled = false;
    btn.textContent = "Baixar grátis";
    if (turnstileId !== null) window.turnstile?.reset(turnstileId);
  }
  atualizarSaldo();
}

// ---------------------------------------------------------------------------

// Patches ainda sem arquivo: aparecem na lista, mas sem detalhes nem download.
function emDesenvolvimento(p) {
  return p.status === "em-desenvolvimento";
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

iniciar();
