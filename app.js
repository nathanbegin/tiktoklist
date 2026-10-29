(() => {
  const KEY = "videotheque-tiktok-v1";
  const PAGE = 60;
  const $ = s => document.querySelector(s);
  const TAG_RE = /#([\p{L}\p{N}_]+)/gu;
  const norm = s => (s || "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const nb = n => Number(n).toLocaleString("fr-CA");

  // ---------- Stockage local ----------
  const lire = (k, def) => { try { const r = localStorage.getItem(k); return r ? JSON.parse(r) : def; } catch { return def; } };
  const ecrire = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } };

  function tagsOf(t){ return [...new Set([...(t||"").matchAll(TAG_RE)].map(m => m[1].toLowerCase()))]; }

  const EXEMPLES = [
    {id:"7300000000000000001", sources:{favoris:"2026-09-14 20:11:02"}, auteur:"Atelier Bois Franc", pseudo:"atelierboisfranc", legende:"Moulure murale en 30 minutes, coupe d’onglet parfaite à chaque fois #diy #moulure #renovation"},
    {id:"7300000000000000002", sources:{favoris:"2026-08-02 12:40:51", aimees:"2026-08-02 12:40:49"}, auteur:"Cuisine de semaine", pseudo:"cuisinedesemaine", legende:"Pâté chinois revisité, prêt en 25 min #recette #souper #quebec"},
    {id:"7300000000000000003", sources:{aimees:"2026-06-21 09:03:10"}, auteur:"ESP Hacks", pseudo:"esphacks", legende:"ESP32-C6 + Zigbee dans Home Assistant, sans hub #esp32 #homeassistant #zigbee"},
    {id:"7300000000000000004", sources:{favoris:"2025-12-30 17:22:45"}, auteur:"Patio Pro", pseudo:"patiopro", legende:"Espacement des solives pour un patio en composite : ce qu’on oublie souvent #patio #deck #diy"},
    {id:"7300000000000000005", sources:{favoris:"2025-11-03 08:15:00"}, statut:"indisponible"},
    {id:"7300000000000000006", sources:{aimees:"2025-07-19 22:01:33"}, auteur:"Route 132", pseudo:"route132", legende:"Trois arrêts à ne pas manquer en Gaspésie #voyage #gaspesie #quebec"}
  ].map(v => ({...v, hashtags: tagsOf(v.legende), statut: v.statut || "ok"}));

  let lib = lire(KEY, null);
  // Migration : l'ancienne version (oEmbed) marquait tout « indisponible » à tort.
  if (lib && !lire(KEY + "-migr2", false)) {
    lib.forEach(v => { if (v.statut === "indisponible") v.statut = "brut"; });
    ecrire(KEY, lib); ecrire(KEY + "-migr2", true);
  }
  let exemple = !lib;
  if (!lib) lib = EXEMPLES;
  const save = () => exemple ? true : ecrire(KEY, lib);
  let state = {q:"", src:"tout", year:"", sort:"desc", tag:"", shown:PAGE};

  // ---------- Réglages ----------
  const DEFAUTS = { lot:100, conc:6, attenteMin:5, attenteMax:45, facteur:1.5, pauseLots:0, essaisReseau:3 };
  const BORNES = { lot:[10,100], conc:[1,12], attenteMin:[1,300], attenteMax:[1,900], facteur:[1,4], pauseLots:[0,60], essaisReseau:[1,20] };
  function borner(r){
    const o = {};
    for (const [k,[min,max]] of Object.entries(BORNES)){
      const v = Number(r?.[k]);
      o[k] = Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : DEFAUTS[k];
    }
    if (o.attenteMax < o.attenteMin) o.attenteMax = o.attenteMin;
    return o;
  }
  let reglages = borner(lire(KEY + "-reglages", DEFAUTS));

  // ---------- Synchronisation ----------
  // sync = { cle, curseur:{maj,id}|null, reinit }
  let sync = lire(KEY + "-sync", { cle:"", curseur:null, reinit:null });
  let aPousser = new Set(lire(KEY + "-apousser", []));
  let bd = { active:false, etat:"verif", message:"Vérification…" };
  // Historique pour le tableau de bord : lots de récupération et événements de synchro
  let histLots = lire(KEY + "-hist-lots", []);
  let histSync = lire(KEY + "-hist-sync", []);
  function noterLot(e){ histLots.push(e); if (histLots.length > 400) histLots = histLots.slice(-400); ecrire(KEY + "-hist-lots", histLots); tdbMaj(); }
  function noterSync(type, n, detail){ histSync.push({t:Date.now(), type, n, detail}); if (histSync.length > 60) histSync = histSync.slice(-60); ecrire(KEY + "-hist-sync", histSync); tdbMaj(); }
  const saveSync = () => { ecrire(KEY + "-sync", sync); ecrire(KEY + "-apousser", [...aPousser]); };

  async function api(chemin, opts = {}){
    const r = await fetch(chemin, { ...opts, headers: { "Content-Type":"application/json", "x-cle": encodeURIComponent((sync.cle || "").normalize("NFC").trim()), ...(opts.headers||{}) } });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(d.erreur || `HTTP ${r.status}`); e.status = r.status; throw e; }
    return d;
  }

  function marquer(ids){
    if (exemple) return;
    for (const id of ids) aPousser.add(String(id));
    saveSync();
    planifierPush();
  }
  let minuteurPush = null;
  function planifierPush(){ clearTimeout(minuteurPush); minuteurPush = setTimeout(() => pousser().catch(() => {}), 1500); }

  let pushEnCours = null;
  async function pousser(){
    if (!bd.active || !aPousser.size) return;
    if (pushEnCours) return pushEnCours;
    pushEnCours = (async () => {
      let envoyees = 0;
      try {
        const parId = new Map(lib.map(v => [v.id, v]));
        while (aPousser.size){
          const ids = [...aPousser].slice(0, 2000);
          const videos = ids.map(id => parId.get(id)).filter(Boolean);
          if (videos.length) await api("/api/bibliotheque", { method:"POST", body: JSON.stringify({ videos }) });
          envoyees += videos.length;
          ids.forEach(id => aPousser.delete(id));
          saveSync();
        }
        if (envoyees) noterSync("envoi", envoyees);
        majEtatBd("ok");
      } catch (e) { noterSync("erreur", envoyees, e.message); majEtatBd("erreur", e.message); throw e; }
      finally { pushEnCours = null; }
    })();
    return pushEnCours;
  }

  // Fusionne une vidéo venue d'ailleurs (fichier ou base) sans perdre une légende déjà obtenue.
  function fusionnerUne(map, n){
    const o = map.get(n.id);
    if (!o){ map.set(n.id, {...n, hashtags: n.hashtags?.length ? n.hashtags : tagsOf(n.legende)}); return "ajout"; }
    o.sources = {...(o.sources||{}), ...(n.sources||{})};
    if (n.statut === "ok" && o.statut !== "ok"){
      Object.assign(o, {legende:n.legende, auteur:n.auteur, pseudo:n.pseudo, publie:n.publie, hashtags: n.hashtags?.length ? n.hashtags : tagsOf(n.legende), statut:"ok"});
      return "enrichie";
    }
    if (n.statut === "indisponible" && o.statut === "brut"){ o.statut = "indisponible"; return "maj"; }
    return null;
  }

  async function tirer(){
    if (!bd.active) return;
    majEtatBd("sync");
    try {
      let nouv = 0, recues = 0, premier = true;
      for (;;){
        const q = sync.curseur ? `?maj=${encodeURIComponent(sync.curseur.maj)}&id=${encodeURIComponent(sync.curseur.id)}` : "";
        const d = await api("/api/bibliotheque" + q);
        if (premier){
          premier = false;
          // La bibliothèque a été vidée depuis un autre appareil : on repart de la base.
          if (d.reinit && sync.reinit && d.reinit !== sync.reinit){
            lib = []; exemple = false; aPousser.clear(); sync.curseur = null; sync.reinit = d.reinit; saveSync();
            showBanner("La bibliothèque a été vidée depuis un autre appareil.");
            continue;
          }
          if (d.reinit) sync.reinit = d.reinit;
        }
        recues += d.videos.length;
        if (d.videos.length){
          if (exemple){ lib = []; exemple = false; }
          const map = new Map(lib.map(v => [v.id, v]));
          for (const v of d.videos) if (fusionnerUne(map, v)) nouv++;
          lib = [...map.values()];
        }
        sync.curseur = d.curseur; saveSync();
        if (!d.suite) break;
      }
      save();
      if (nouv){ buildYears(); render(); }
      noterSync("reception", nouv, recues ? `${recues} lues` : "");
      sync.derniere = Date.now(); saveSync();
      majEtatBd("ok");
      return nouv;
    } catch (e) { noterSync("erreur", 0, e.message); majEtatBd("erreur", e.message); throw e; }
  }

  async function connecter(){
    majEtatBd("verif");
    let e;
    try { e = await api("/api/etat"); }
    catch (err) { bd.active = false; majEtatBd("hors", `Serveur injoignable (${err.message}).`); return; }
    if (!e.bd){ bd.active = false; majEtatBd("hors", "Aucune base de données configurée sur le serveur."); return; }
    if (e.cleRequise && !e.cleValide){ bd.active = false; majEtatBd("cle", "Clé d’accès refusée."); ouvrirPorte("Clé d’accès refusée."); return; }
    bd.active = true;
    const premiereFois = !sync.curseur;
    try {
      const r = await api("/api/reglages");
      if (r.reglages){ reglages = borner(r.reglages); ecrire(KEY + "-reglages", reglages); remplirReglages(); }
      else await api("/api/reglages", { method:"PUT", body: JSON.stringify({ reglages }) });
      await tirer();
      // Première connexion de cet appareil : on envoie ce qu'il avait déjà.
      if (premiereFois && !exemple) marquer(lib.map(v => v.id));
      await pousser();
    } catch {}
  }

  function majEtatBd(etat, message){
    bd.etat = etat;
    const textes = {
      verif: "Vérification de la base…",
      sync: "Synchronisation…",
      ok: `Synchronisée${aPousser.size ? ` · ${nb(aPousser.size)} en attente d’envoi` : ""}`,
      erreur: `Erreur de synchro : ${message || ""}`,
      hors: message || "Base non connectée",
      cle: message || "Clé d’accès requise",
    };
    bd.message = textes[etat];
    const pastille = $("#syncPill");
    pastille.textContent = etat === "ok" ? "Synchronisée" : etat === "sync" || etat === "verif" ? "Synchro…" : etat === "hors" ? "Local seulement" : "À vérifier";
    pastille.dataset.etat = etat;
    pastille.title = bd.message;
    $("#syncEtat").textContent = bd.message;
    $("#syncEtat").dataset.etat = etat;
    tdbMaj();
  }

  // ---------- Import ----------
  function sourceOf(path){
    const c = path.join(" ").toLowerCase();
    if (c.includes("favorite") && c.includes("video")) return "favoris";
    if (c.includes("like")) return "aimees";
    return null; // historique, partages : ignorés
  }
  function walk(node, path, out){
    if (Array.isArray(node)){
      const src = sourceOf(path);
      for (const el of node){
        if (el && typeof el === "object"){
          const link = el.Link || el.link || el.VideoLink, date = el.Date || el.date;
          const m = link && /\/video\/(\d+)/.exec(link);
          if (m && src) out.push({id:m[1], lien:link, date, source:src});
          else walk(el, path, out);
        }
      }
    } else if (node && typeof node === "object"){
      for (const [k,v] of Object.entries(node)) walk(v, path.concat(k), out);
    }
  }
  function fromExport(json){
    const raw = []; walk(json, [], raw);
    const map = new Map();
    for (const r of raw){
      const v = map.get(r.id) || {id:r.id, lien:r.lien, sources:{}, statut:"brut", hashtags:[]};
      v.sources[r.source] = r.date; map.set(r.id, v);
    }
    return [...map.values()];
  }
  const fromEnriched = json => (json.videos || []).map(v => ({...v, id:String(v.id)}));

  async function readFile(file){
    let text;
    if (/\.zip$/i.test(file.name)){
      if (!window.JSZip) throw new Error("Lecture des .zip indisponible. Décompresse le fichier et dépose le .json.");
      const zip = await JSZip.loadAsync(file);
      const entry = Object.values(zip.files).find(f => !f.dir && /\.json$/i.test(f.name));
      if (!entry) throw new Error("Le .zip ne contient pas de .json. Redemande l’export TikTok au format JSON (pas TXT).");
      text = await entry.async("string");
    } else text = await file.text();
    let json;
    try { json = JSON.parse(text.replace(/^﻿/, "")); }
    catch { throw new Error("Ce fichier n’est pas du JSON valide. Choisis l’export au format JSON dans TikTok."); }
    const items = json.format === "videotheque-tiktok/1" ? fromEnriched(json) : fromExport(json);
    if (!items.length) throw new Error("Aucune vidéo favorite ou aimée trouvée dans ce fichier.");
    if (exemple){ lib = []; exemple = false; }
    const map = new Map(lib.map(v => [v.id, v]));
    let added = 0, enriched = 0;
    for (const n of items){ const r = fusionnerUne(map, n); if (r === "ajout") added++; else if (r === "enrichie") enriched++; }
    lib = [...map.values()];
    const ok = save();
    marquer(items.map(v => v.id));
    const brut = lib.filter(v => v.statut === "brut").length;
    let msg = `${file.name} importé : ${nb(added)} nouvelles vidéos${enriched ? `, ${nb(enriched)} enrichies` : ""}. Total : ${nb(lib.length)}.`;
    if (brut) msg += ` ${nb(brut)} vidéos n’ont pas encore de légende.`;
    if (!ok) msg += " Attention : ce navigateur n’a pas pu garder la bibliothèque en local.";
    showBanner(msg);
    state.shown = PAGE; buildYears(); render();
  }
  function showBanner(t){ const b = $("#banner"); b.textContent = t; b.hidden = !t; }

  const drop = $("#drop"), fileIn = $("#file");
  fileIn.addEventListener("change", () => { [...fileIn.files].forEach(f => readFile(f).catch(e => showBanner(e.message))); fileIn.value = ""; });
  ["dragenter","dragover"].forEach(e => drop.addEventListener(e, ev => { ev.preventDefault(); drop.classList.add("over"); }));
  ["dragleave","drop"].forEach(e => drop.addEventListener(e, ev => { ev.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", ev => [...ev.dataTransfer.files].forEach(f => readFile(f).catch(e => showBanner(e.message))));

  // Vider, avec confirmation intégrée à la page
  const clearZone = $("#clearZone");
  function resetClear(){ clearZone.innerHTML = '<button class="btn" id="clearBtn" type="button">Vider la bibliothèque</button>'; $("#clearBtn").onclick = askClear; }
  function askClear(){
    const ou = bd.active ? "sur tous tes appareils" : "dans ce navigateur";
    clearZone.innerHTML = `<span class="confirm">Tout effacer ${ou} ? <button class="btn primary" type="button" id="yes">Effacer</button><button class="btn" type="button" id="no">Annuler</button></span>`;
    $("#yes").onclick = async () => {
      if (bd.active){
        try { const r = await api("/api/bibliotheque", { method:"DELETE" }); sync.reinit = r.reinit; }
        catch (e) { showBanner("Impossible de vider la base : " + e.message); resetClear(); return; }
      }
      lib = []; exemple = false; aPousser.clear(); sync.curseur = null; saveSync(); save();
      showBanner("Bibliothèque vidée."); buildYears(); render(); resetClear();
    };
    $("#no").onclick = resetClear;
  }
  resetClear();

  // ---------- Recherche ----------
  const dateOf = v => { const d = Object.values(v.sources || {}).filter(Boolean).sort(); return d.length ? d[d.length-1] : ""; };
  function buildYears(){
    const ys = [...new Set(lib.map(v => dateOf(v).slice(0,4)).filter(Boolean))].sort().reverse();
    $("#year").innerHTML = '<option value="">Toutes les années</option>' + ys.map(y => `<option value="${y}">${y}</option>`).join("");
    if (!ys.includes(state.year)) state.year = "";
    $("#year").value = state.year;
  }
  function filtered(){
    const terms = norm(state.q).split(/\s+/).filter(Boolean);
    let out = lib.filter(v => {
      if (state.src !== "tout" && !(state.src in (v.sources||{}))) return false;
      if (state.year && !dateOf(v).startsWith(state.year)) return false;
      if (state.tag && !(v.hashtags||[]).includes(state.tag)) return false;
      if (!terms.length) return true;
      const hay = norm(`${v.legende||""} ${v.auteur||""} @${v.pseudo||""} ${(v.hashtags||[]).map(t=>"#"+t).join(" ")}`);
      return terms.every(t => hay.includes(t));
    });
    const s = state.sort;
    out.sort((a,b) => s === "auteur" ? (a.auteur||"~").localeCompare(b.auteur||"~","fr") : s === "asc" ? dateOf(a).localeCompare(dateOf(b)) : dateOf(b).localeCompare(dateOf(a)));
    return out;
  }
  const esc = s => (s||"").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  function highlight(text){
    let h = esc(text).replace(/#([\p{L}\p{N}_]+)/gu, (m,t) => `<span class="h" data-tag="${t.toLowerCase()}">${m}</span>`);
    const terms = state.q.trim().split(/\s+/).filter(t => t.length > 1).map(t => t.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"));
    if (terms.length) h = h.replace(new RegExp(`(?![^<]*>)(${terms.join("|")})`, "giu"), "<mark>$1</mark>");
    return h;
  }
  function card(v){
    const user = v.pseudo ? `@${v.pseudo}` : "";
    const url = `https://www.tiktok.com/${v.pseudo ? "@"+encodeURIComponent(v.pseudo) : "@"}/video/${v.id}`;
    const pills = [];
    if (v.sources?.favoris !== undefined) pills.push('<span class="pill fav">Favori</span>');
    if (v.sources?.aimees !== undefined) pills.push('<span class="pill like">Aimée</span>');
    const cap = v.statut === "ok" ? `<p class="cap${ouverts.has(v.id) ? " ouvert" : ""}">${highlight(v.legende) || '<span class="cap vide">Sans légende</span>'}</p><button class="lire" type="button" hidden>${ouverts.has(v.id) ? "Réduire" : "Lire la suite"}</button>`
      : `<p class="cap vide">${v.statut === "indisponible" ? "Vidéo supprimée ou privée" : "Légende pas encore récupérée"} · ID ${v.id}</p>`;
    return `<article class="card" data-id="${v.id}" data-url="${url}" tabindex="0" role="link" aria-label="Ouvrir la vidéo${v.auteur ? " de " + esc(v.auteur) : ""}">
      <div class="who">${v.auteur ? `<a href="https://www.tiktok.com/@${encodeURIComponent(v.pseudo||"")}" target="_blank" rel="noopener" title="${esc(user)}">${esc(v.auteur)}</a>` : `<span class="note">Créateur inconnu</span>`}<span class="note">${esc(user)}</span></div>
      ${cap}
      <div class="foot"><span style="display:flex;gap:6px;align-items:center">${pills.join("")}<span class="date">${esc(dateOf(v).slice(0,10))}</span></span>
      <a class="open" href="${url}" target="_blank" rel="noopener">Ouvrir ↗</a></div></article>`;
  }
  function renderTags(list){
    const counts = new Map();
    list.forEach(v => (v.hashtags||[]).forEach(t => counts.set(t, (counts.get(t)||0)+1)));
    const top = [...counts].sort((a,b) => b[1]-a[1]).slice(0, 14);
    if (state.tag && !top.some(([t]) => t === state.tag)) top.unshift([state.tag, counts.get(state.tag)||0]);
    $("#tags").innerHTML = top.map(([t,n]) => `<button type="button" class="chip${t===state.tag?" on":""}" data-tag="${esc(t)}">#${esc(t)}<b>${n}</b></button>`).join("");
  }
  function render(){
    const list = filtered();
    const n = list.length;
    $("#count").textContent = `${nb(n)} vidéo${n>1?"s":""} sur ${nb(lib.length)}${exemple ? " · données d’exemple" : ""}`;
    renderTags(list);
    $("#grid").innerHTML = n ? list.slice(0, state.shown).map(card).join("")
      : `<div class="empty" style="grid-column:1/-1">${lib.length ? "Aucun résultat. Essaie un autre mot ou retire un filtre." : "Bibliothèque vide. Dépose ton export TikTok ci-dessus pour commencer."}</div>`;
    marquerLongues();
    $("#moreBtn").hidden = n <= state.shown;
    $("#moreBtn").textContent = `Afficher plus (${nb(n - state.shown)} restantes)`;
    updateEnrich();
  }

  let t;
  $("#q").addEventListener("input", e => { clearTimeout(t); t = setTimeout(() => { state.q = e.target.value; state.shown = PAGE; render(); }, 120); });
  document.querySelectorAll(".seg button").forEach(b => b.addEventListener("click", () => {
    document.querySelectorAll(".seg button").forEach(x => x.setAttribute("aria-pressed", x === b));
    state.src = b.dataset.src; state.shown = PAGE; render();
  }));
  $("#year").addEventListener("change", e => { state.year = e.target.value; state.shown = PAGE; render(); });
  $("#sort").addEventListener("change", e => { state.sort = e.target.value; render(); });
  $("#moreBtn").addEventListener("click", () => { state.shown += PAGE; render(); });
  document.addEventListener("click", e => {
    const el = e.target.closest("[data-tag]"); if (!el) return;
    state.tag = state.tag === el.dataset.tag ? "" : el.dataset.tag; state.shown = PAGE; render();
  });

  // ---------- Descriptions longues : « Lire la suite » ----------
  const ouverts = new Set();
  function marquerLongues(){
    requestAnimationFrame(() => document.querySelectorAll("#grid .card").forEach(c => {
      const cap = c.querySelector(".cap"), b = c.querySelector(".lire");
      if (!cap || !b) return;
      b.hidden = !(cap.classList.contains("ouvert") || cap.scrollHeight > cap.clientHeight + 1);
    }));
  }
  window.addEventListener("resize", () => { clearTimeout(marquerLongues.t); marquerLongues.t = setTimeout(marquerLongues, 150); });
  $("#grid").addEventListener("click", e => {
    const b = e.target.closest(".lire"); if (!b) return;
    const c = b.closest(".card"), cap = c.querySelector(".cap");
    const ouvrir = !cap.classList.contains("ouvert");
    cap.classList.toggle("ouvert", ouvrir);
    b.textContent = ouvrir ? "Réduire" : "Lire la suite";
    if (ouvrir) ouverts.add(c.dataset.id); else ouverts.delete(c.dataset.id);
  });

  // ---------- Clic sur une case : ouvrir la vidéo ----------
  // Le créateur, les hashtags et « Ouvrir ↗ » gardent leur propre action.
  function ouvrirCase(c){ if (c?.dataset.url) window.open(c.dataset.url, "_blank", "noopener"); }
  $("#grid").addEventListener("click", e => {
    if (e.target.closest("a, button, [data-tag]")) return;
    if (window.getSelection()?.toString()) return; // sélection de texte : ne pas ouvrir
    ouvrirCase(e.target.closest(".card"));
  });
  $("#grid").addEventListener("keydown", e => {
    if (e.key === "Enter" && e.target.classList?.contains("card")) ouvrirCase(e.target);
  });

  // ---------- Mobile : cacher les hashtags en défilant vers le bas ----------
  const barre = $(".bar"), mobile = window.matchMedia("(max-width: 640px)");
  let dernierY = window.scrollY;
  function majBarre(){
    const y = window.scrollY, dy = y - dernierY;
    if (!mobile.matches || y < 80) barre.classList.remove("compact");
    else if (dy > 6) barre.classList.add("compact");     // vers le bas
    else if (dy < -6) barre.classList.remove("compact"); // vers le haut
    if (Math.abs(dy) > 6 || y < 80) dernierY = y;
  }
  window.addEventListener("scroll", majBarre, { passive:true });
  mobile.addEventListener?.("change", majBarre);
  // Toucher la recherche réaffiche les hashtags
  $("#q").addEventListener("focus", () => barre.classList.remove("compact"));

  // ---------- Récupération des légendes (fonction serveur /api/video) ----------
  let enCours = false, arret = false, sauter = null;

  // Attente avec compte à rebours ; « Réessayer maintenant » ou « Arrêter » l'écourtent.
  async function attendre(secondes, raison){
    if (secondes <= 0) return;
    const skip = $("#skipBtn");
    skip.hidden = false;
    await new Promise(fin => {
      let reste = Math.round(secondes);
      const maj = () => updateEnrich(`${raison}. Nouvel essai dans ${reste} s…`);
      maj();
      const iv = setInterval(() => { if (--reste <= 0 || arret) stop(); else maj(); }, 1000);
      function stop(){ clearInterval(iv); sauter = null; fin(); }
      sauter = stop;
    });
    skip.hidden = true;
  }

  function updateEnrich(msg){
    const reste = lib.filter(v => v.statut === "brut").length;
    const total = lib.length;
    const fait = total - reste;
    $("#enrich").hidden = exemple || (!reste && !enCours);
    $("#enrichTitle").textContent = enCours ? "Récupération en cours…" : `${nb(reste)} légendes à récupérer`;
    $("#enrichNote").textContent = msg || (enCours
      ? `${nb(fait)} / ${nb(total)} traitées · lots de ${reglages.lot}, ${reglages.conc} requêtes simultanées.`
      : `Tu peux arrêter et reprendre plus tard${bd.active ? ", même depuis un autre appareil" : ""}.`);
    $("#enrichBar").style.width = total ? `${(fait / total) * 100}%` : "0";
    $("#enrichBtn").textContent = enCours ? "Arrêter" : (fait ? "Reprendre" : "Récupérer les légendes");
  }

  async function enrichir(){
    if (enCours){ arret = true; if (sauter) sauter(); return; }
    enCours = true; arret = false; updateEnrich();
    let attente = 0, echecs = 0;
    while (!arret){
      const R = reglages; // relu à chaque lot : les changements de réglages s'appliquent tout de suite
      const lot = lib.filter(v => v.statut === "brut")
        .sort((a, b) => dateOf(b).localeCompare(dateOf(a))) // plus récentes d’abord
        .slice(0, R.lot);
      if (!lot.length) break;
      let data;
      const t0 = Date.now();
      try {
        data = await api(`/api/video?ids=${lot.map(v => v.id).join(",")}&conc=${R.conc}`);
        echecs = 0;
      } catch (e) {
        noterLot({t:Date.now(), n:lot.length, ok:0, ind:0, err:lot.length, ms:Date.now()-t0, rl:false, echec:true});
        if (e.status === 401){ updateEnrich("Clé d’accès refusée. Vérifie-la dans Réglages."); break; }
        if (++echecs >= R.essaisReseau){ updateEnrich(`Le serveur ne répond pas (${e.message}). Réessaie dans quelques minutes.`); break; }
        await attendre(Math.min(R.attenteMin, 10), `Erreur serveur (${e.message})`); continue;
      }
      let progres = 0;
      const traites = [];
      for (const v of lot){
        const r = data.results?.[v.id];
        if (!r || r.statut === "erreur") continue; // reste « brut », sera réessayée
        progres++; traites.push(v.id);
        if (r.statut === "ok") Object.assign(v, {statut:"ok", legende:r.legende, auteur:r.auteur, pseudo:r.pseudo, publie:r.publie, hashtags:tagsOf(r.legende)});
        else v.statut = "indisponible";
      }
      save(); marquer(traites); render();
      {
        let ok = 0, ind = 0;
        for (const id of traites){ const v = lot.find(x => x.id === id); if (v?.statut === "ok") ok++; else ind++; }
        noterLot({t:Date.now(), n:lot.length, ok, ind, err:lot.length - ok - ind, ms:Date.now()-t0, rl:!!data.rateLimited});
      }
      if (data.rateLimited || !progres){
        // Délai croissant (réglable) ; remis à zéro dès qu'un lot avance.
        attente = attente ? Math.min(Math.ceil(attente * R.facteur), R.attenteMax) : R.attenteMin;
        const raison = data.rateLimited ? "TikTok limite les requêtes" : "TikTok n’a renvoyé aucune légende pour ce lot";
        await attendre(attente, raison);
      } else {
        attente = 0;
        if (R.pauseLots) await attendre(R.pauseLots, "Pause entre les lots");
      }
    }
    enCours = false; buildYears(); render();
    const reste = lib.filter(v => v.statut === "brut").length;
    if (!reste) showBanner(`Terminé : ${nb(lib.filter(v => v.statut === "ok").length)} vidéos avec légende, ${nb(lib.filter(v => v.statut === "indisponible").length)} indisponibles.`);
  }
  $("#enrichBtn").addEventListener("click", enrichir);
  $("#skipBtn").addEventListener("click", () => sauter && sauter());

  // ---------- Sauvegarde fichier ----------
  $("#saveBtn").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify({format:"videotheque-tiktok/1", videos: lib}, null, 1)], {type:"application/json"});
    const a = Object.assign(document.createElement("a"), {href: URL.createObjectURL(blob), download: `videotheque-tiktok-${new Date().toISOString().slice(0,10)}.json`});
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  // ---------- Page Réglages ----------
  const dlg = $("#reglages");
  const champs = Object.keys(DEFAUTS);
  function remplirReglages(){ for (const k of champs) $("#r-" + k).value = reglages[k]; apercu(); }
  function lireForm(){ const o = {}; for (const k of champs) o[k] = Number($("#r-" + k).value); return borner(o); }
  function apercu(){
    const r = lireForm(); const seq = []; let a = 0;
    for (let i = 0; i < 6; i++){ a = a ? Math.min(Math.ceil(a * r.facteur), r.attenteMax) : r.attenteMin; seq.push(a); }
    $("#r-apercu").textContent = `Délais successifs : ${seq.join(" s, ")} s…`;
  }
  dlg.addEventListener("input", apercu);
  $("#reglagesBtn").addEventListener("click", () => { remplirReglages(); majEtatBd(bd.etat, bd.etat === "erreur" ? bd.message.replace(/^Erreur de synchro : /, "") : undefined); dlg.showModal(); });
  $("#r-defaut").addEventListener("click", () => { for (const k of champs) $("#r-" + k).value = DEFAUTS[k]; apercu(); });
  $("#r-annuler").addEventListener("click", () => dlg.close());
  $("#r-form").addEventListener("submit", ev => {
    ev.preventDefault();
    reglages = lireForm(); ecrire(KEY + "-reglages", reglages);
    dlg.close();
    showBanner("Réglages enregistrés.");
    updateEnrich();
    if (bd.active) api("/api/reglages", { method:"PUT", body: JSON.stringify({ reglages }) }).catch(e => majEtatBd("erreur", e.message));
  });
  $("#r-changerCle").addEventListener("click", () => { dlg.close(); ouvrirPorte(); });
  $("#r-sync").addEventListener("click", async () => {
    if (!bd.active) await connecter();
    else { try { await pousser(); await tirer(); } catch {} }
  });

  // Resynchroniser quand on revient sur l'onglet
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && bd.active && !enCours) tirer().then(() => pousser()).catch(() => {});
  });

  // ---------- Tableau de bord ----------
  const tdb = $("#tableau"), bulle = $("#t-bulle");
  const coul = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const heure = t => new Date(t).toLocaleTimeString("fr-CA", {hour:"2-digit", minute:"2-digit"});
  const heureSec = t => new Date(t).toLocaleTimeString("fr-CA", {hour:"2-digit", minute:"2-digit", second:"2-digit"});
  function ilYa(t){
    if (!t) return "jamais";
    const s = Math.round((Date.now() - t) / 1000);
    if (s < 60) return "à l’instant";
    if (s < 3600) return `il y a ${Math.round(s/60)} min`;
    if (s < 86400) return `il y a ${Math.round(s/3600)} h`;
    return `il y a ${Math.round(s/86400)} j`;
  }
  function duree(min){
    if (!isFinite(min)) return "—";
    if (min < 1) return "< 1 min";
    if (min < 90) return `${Math.round(min)} min`;
    return `${Math.floor(min/60)} h ${String(Math.round(min%60)).padStart(2,"0")}`;
  }
  function pas(max){ // graduation « ronde »
    const brut = max / 4, p = Math.pow(10, Math.floor(Math.log10(brut || 1))), m = brut / p;
    return Math.max(1, (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p); // comptes entiers : jamais de demi-graduation
  }
  function montrerBulle(e, html){ bulle.innerHTML = html; bulle.hidden = false; placerBulle(e); }
  function placerBulle(e){
    const w = bulle.offsetWidth, h = bulle.offsetHeight;
    let x = e.clientX + 14, y = e.clientY - h - 12;
    if (x + w > innerWidth - 8) x = e.clientX - w - 14;
    if (y < 8) y = e.clientY + 16;
    bulle.style.left = x + "px"; bulle.style.top = y + "px";
  }
  const cacherBulle = () => { bulle.hidden = true; };
  const ligneLg = (c, t) => `<span class="lg"><i style="background:${c}"></i>${t}</span>`;

  // Barres verticales empilées (SVG), une seule échelle, survol = infobulle
  function barres(el, { cats, series, bulleDe, etiq }){
    if (!cats.length){ el.innerHTML = '<p class="vide">Pas encore de données.</p>'; return; }
    // Dessiné à la largeur réelle du conteneur (hauteur fixe) : pas d'étirement, texte à 1:1
    const W = Math.max(300, Math.round(el.clientWidth || el.parentElement?.clientWidth || 600)), H = 190, g = 36, d = 22, h = 8, b = 26;
    const tot = cats.map((_, i) => series.reduce((a, s) => a + s.vals[i], 0));
    const p = pas(Math.max(1, ...tot)), max = Math.ceil(Math.max(1, ...tot) / p) * p;
    const ih = H - h - b, iw = W - g - d, bw = iw / cats.length, larg = Math.max(3, Math.min(28, bw * 0.68));
    const y = v => h + ih - (v / max) * ih;
    let svg = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(etiq)}">`;
    for (let v = 0; v <= max; v += p){
      svg += `<line class="grille" x1="${g}" x2="${W-d}" y1="${y(v)}" y2="${y(v)}"/><text x="${g-6}" y="${y(v)+3.5}" text-anchor="end">${nb(v)}</text>`;
    }
    const tous = Math.max(1, Math.ceil(cats.length / Math.max(1, Math.floor(iw / 52)))); // pas d'étiquettes qui se chevauchent
    cats.forEach((c, i) => {
      const x = g + i * bw + (bw - larg) / 2;
      let base = 0;
      const vis = series.map((s, k) => ({ s, v: s.vals[i], k })).filter(o => o.v > 0);
      vis.forEach((o, j) => {
        const y0 = y(base), y1 = y(base + o.v);
        const haut = j === vis.length - 1;
        const gap = j > 0 ? 2 : 0; // 2 px entre segments
        const hh = Math.max(0, y0 - y1 - gap);
        const r = haut ? Math.min(4, larg / 2, hh) : 0;
        svg += `<path fill="${o.s.couleur}" d="M${x},${y1 + hh}V${y1 + r}${r ? `Q${x},${y1} ${x + r},${y1}` : ""}H${x + larg - r}${r ? `Q${x + larg},${y1} ${x + larg},${y1 + r}` : ""}V${y1 + hh}Z"/>`;
        base += o.v;
      });
      if (i % tous === 0){
        const cx = Math.min(x + larg/2, W - 4);
        const ancre = cx > W - 26 ? "end" : "middle"; // la dernière étiquette ne déborde pas
        svg += `<text x="${cx}" y="${H - 8}" text-anchor="${ancre}">${esc(c)}</text>`;
      }
      svg += `<rect class="cible" data-i="${i}" x="${g + i*bw}" y="${h}" width="${bw}" height="${ih}"/>`;
    });
    svg += `<line x1="${g}" x2="${W-d}" y1="${y(0)}" y2="${y(0)}" stroke="var(--muted)" stroke-width="1"/></svg>`;
    el.innerHTML = svg;
    el.querySelectorAll(".cible").forEach(r => {
      r.addEventListener("pointermove", e => montrerBulle(e, bulleDe(+r.dataset.i)));
      r.addEventListener("pointerleave", cacherBulle);
    });
  }

  function legende(el, items){ el.innerHTML = items.map(([c, t, n]) => `<span><i style="background:${c}"></i>${t}${n !== undefined ? ` <b>${nb(n)}</b>` : ""}</span>`).join(""); }

  function vitesse(){
    const depuis = Date.now() - 10 * 60000;
    const r = histLots.filter(l => l.t >= depuis);
    if (r.length < 1) return null;
    const faits = r.reduce((a, l) => a + l.ok + l.ind, 0);
    const debut = Math.min(...r.map(l => l.t - l.ms));
    const min = Math.max(0.5, (Date.now() - debut) / 60000);
    return faits / min;
  }

  function tdbRendre(){
    const C = { ok: coul("--st-good"), ind: coul("--st-neutre"), att: coul("--st-warn"), err: coul("--st-crit"), bleu: coul("--viz-blue"), orange: coul("--viz-orange") };
    const total = lib.length, ok = lib.filter(v => v.statut === "ok").length, ind = lib.filter(v => v.statut === "indisponible").length, att = total - ok - ind;
    const vit = vitesse();
    const pct = n => total ? Math.round(n / total * 100) : 0;
    const etatSync = { ok:"Synchronisée", sync:"En cours…", verif:"Vérification…", erreur:"Erreur", hors:"Locale seulement", cle:"Clé requise" }[bd.etat] || "—";
    $("#t-tuiles").innerHTML = [
      ["Vidéos", nb(total), exemple ? "données d’exemple" : `${nb(lib.filter(v => "favoris" in (v.sources||{})).length)} favoris · ${nb(lib.filter(v => "aimees" in (v.sources||{})).length)} aimées`],
      ["Avec légende", nb(ok), `${pct(ok)} % de la bibliothèque`],
      ["À récupérer", nb(att), enCours ? "récupération en cours" : att ? "en attente" : "rien en attente"],
      ["Indisponibles", nb(ind), "supprimées ou privées"],
      ["Vitesse", vit ? `${nb(Math.round(vit))}/min` : "—", vit && att ? `fin estimée dans ${duree(att / vit)}` : "sur les 10 dernières minutes"],
      ["Synchronisation", etatSync, bd.active ? `${aPousser.size ? nb(aPousser.size) + " à envoyer · " : ""}dernière ${ilYa(sync.derniere)}` : bd.message],
    ].map(([l, v, sous]) => `<div class="tuile"><span class="lib">${l}</span><span class="val">${v}</span><span class="sous">${esc(sous)}</span></div>`).join("");

    // Répartition
    $("#t-repart").innerHTML = total ? [[ok, C.ok], [ind, C.ind], [att, C.att]].filter(([n]) => n).map(([n, c]) => `<span style="flex-grow:${n};background:${c}"></span>`).join("") : "";
    $("#t-repart").setAttribute("aria-label", `${ok} avec légende, ${ind} indisponibles, ${att} à récupérer`);
    legende($("#t-repart-leg"), [[C.ok, "✓ Avec légende", ok], [C.ind, "⊘ Indisponibles", ind], [C.att, "◷ À récupérer", att]]);

    // Lots
    const lots = histLots.slice(-40);
    const rl = lots.filter(l => l.rl).length;
    $("#t-lots-note").textContent = lots.length ? `${lots.length} lots · durée moyenne ${(lots.reduce((a, l) => a + l.ms, 0) / lots.length / 1000).toFixed(1)} s${rl ? ` · ${rl} limités par TikTok` : ""}` : "";
    legende($("#t-lots-leg"), [[C.ok, "✓ Légende obtenue"], [C.ind, "⊘ Indisponible"], [C.err, "↻ À réessayer"]]);
    barres($("#t-lots"), {
      etiq: "Résultats des derniers lots",
      cats: lots.map(l => heure(l.t)),
      series: [
        { couleur: C.ok, vals: lots.map(l => l.ok) },
        { couleur: C.ind, vals: lots.map(l => l.ind) },
        { couleur: C.err, vals: lots.map(l => l.err) },
      ],
      bulleDe: i => { const l = lots[i]; return `<b>Lot de ${heureSec(l.t)}</b><br>${ligneLg(C.ok, `${l.ok} légendes`)}${ligneLg(C.ind, `${l.ind} indisponibles`)}${ligneLg(C.err, `${l.err} à réessayer`)}Durée : ${(l.ms/1000).toFixed(1)} s${l.rl ? "<br>TikTok a limité les requêtes" : ""}${l.echec ? "<br>Le serveur n’a pas répondu" : ""}`; },
    });

    // Par mois
    const parMois = new Map();
    for (const v of lib) for (const [src, d] of Object.entries(v.sources || {})){
      const m = (d || "").slice(0, 7); if (!/^\d{4}-\d{2}$/.test(m)) continue;
      const o = parMois.get(m) || { favoris:0, aimees:0 }; o[src] = (o[src] || 0) + 1; parMois.set(m, o);
    }
    let mois = [...parMois.keys()].sort();
    if (mois.length){ // combler les mois vides, 24 derniers mois au plus
      const tous = []; let [a, m] = mois[0].split("-").map(Number); const fin = mois[mois.length - 1];
      for (;;){ const k = `${a}-${String(m).padStart(2,"0")}`; tous.push(k); if (k >= fin) break; if (++m > 12){ m = 1; a++; } }
      mois = tous.slice(-24);
    }
    const nomMois = k => new Date(k + "-15").toLocaleDateString("fr-CA", { month:"short", year:"2-digit" }).replace(".", "");
    legende($("#t-mois-leg"), [[C.bleu, "Favoris"], [C.orange, "Aimées"]]);
    barres($("#t-mois"), {
      etiq: "Vidéos sauvegardées par mois",
      cats: mois.map(nomMois),
      series: [
        { couleur: C.bleu, vals: mois.map(k => parMois.get(k)?.favoris || 0) },
        { couleur: C.orange, vals: mois.map(k => parMois.get(k)?.aimees || 0) },
      ],
      bulleDe: i => { const o = parMois.get(mois[i]) || {}; const lib2 = new Date(mois[i] + "-15").toLocaleDateString("fr-CA", { month:"long", year:"numeric" }); return `<b>${lib2}</b><br>${ligneLg(C.bleu, `${o.favoris || 0} favoris`)}${ligneLg(C.orange, `${o.aimees || 0} aimées`)}`; },
    });

    // Créateurs
    const crea = new Map();
    for (const v of lib) if (v.pseudo){ const o = crea.get(v.pseudo) || { nom: v.auteur || v.pseudo, n:0 }; o.n++; crea.set(v.pseudo, o); }
    const top = [...crea].sort((a, b) => b[1].n - a[1].n).slice(0, 10);
    const maxC = top[0]?.[1].n || 1;
    $("#t-crea").innerHTML = top.length ? top.map(([p, o]) => `<button type="button" class="hbarre" data-pseudo="${esc(p)}" title="@${esc(p)}"><span class="nom">${esc(o.nom)}</span><span class="piste"><span style="width:${Math.max(2, o.n / maxC * 100)}%"></span></span><span class="n">${nb(o.n)}</span></button>`).join("")
      : '<p class="vide">Les créateurs apparaîtront une fois les légendes récupérées.</p>';

    // Journal
    const typ = { envoi:["Envoi", C.bleu], reception:["Réception", C.orange], erreur:["Erreur", C.err] };
    $("#t-journal").innerHTML = histSync.length ? histSync.slice().reverse().slice(0, 40).map(e => {
      const [t, c] = typ[e.type] || [e.type, C.ind];
      const det = e.type === "envoi" ? `${nb(e.n)} vidéos envoyées` : e.type === "reception" ? (e.n ? `${nb(e.n)} nouvelles ou mises à jour` : "rien de nouveau") + (e.detail ? ` · ${e.detail}` : "") : (e.detail || "");
      return `<li><span class="h">${heureSec(e.t)}</span><span class="ty"><i style="background:${c}"></i>${t}</span><span class="d">${esc(det)}</span></li>`;
    }).join("") : '<li class="vide">Aucune synchronisation pour l’instant.</li>';

    $("#t-maj").textContent = `Mis à jour à ${heureSec(Date.now())}`;
  }
  let tdbIntervalle = null;
  function tdbMaj(){ if (tdb?.open) tdbRendre(); }
  function ouvrirTdb(){ tdbRendre(); tdb.showModal(); clearInterval(tdbIntervalle); tdbIntervalle = setInterval(tdbMaj, 5000); }
  tdb.addEventListener("close", () => { clearInterval(tdbIntervalle); cacherBulle(); });
  window.addEventListener("resize", () => { clearTimeout(tdbMaj.t); tdbMaj.t = setTimeout(tdbMaj, 150); });
  $("#tdbBtn").addEventListener("click", ouvrirTdb);
  $("#syncPill").addEventListener("click", ouvrirTdb);
  $("#t-fermer").addEventListener("click", () => tdb.close());
  $("#t-sync").addEventListener("click", async () => {
    if (!bd.active) await connecter(); else { try { await pousser(); await tirer(); } catch {} }
    tdbMaj();
  });
  $("#t-crea").addEventListener("click", e => {
    const b = e.target.closest("[data-pseudo]"); if (!b) return;
    $("#q").value = "@" + b.dataset.pseudo; state.q = $("#q").value; state.shown = PAGE; render();
    tdb.close(); window.scrollTo({ top: 0 });
  });

  // ---------- Écran de clé d'accès ----------
  const porte = $("#gate"), gCle = $("#g-cle"), gErr = $("#g-erreur");
  function ouvrirPorte(message){
    gCle.value = sync.cle || "";
    gErr.hidden = !message; gErr.textContent = message || "";
    porte.hidden = false;
    setTimeout(() => gCle.focus(), 50);
  }
  async function etatAvec(cle){
    const r = await fetch("/api/etat", { cache:"no-store", headers: { "x-cle": encodeURIComponent((cle || "").normalize("NFC").trim()) } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }
  $("#g-voir").addEventListener("click", e => {
    const voir = gCle.type === "password";
    gCle.type = voir ? "text" : "password";
    e.currentTarget.textContent = voir ? "Masquer" : "Afficher";
    e.currentTarget.setAttribute("aria-pressed", voir);
  });
  $("#g-form").addEventListener("submit", async ev => {
    ev.preventDefault();
    const cle = gCle.value.trim();
    const bouton = $("#g-ok"); bouton.disabled = true; bouton.textContent = "Vérification…";
    try {
      const e = await etatAvec(cle);
      if (e.cleRequise && !e.cleValide){
        gErr.textContent = `Clé refusée (${[...cle].length} caractères). Les majuscules comptent. Vérifie la valeur de ACCES_CLE dans Vercel, puis redéploie si tu l’as changée.`;
        gErr.hidden = false; gCle.select();
        return;
      }
      sync.cle = cle; saveSync();
      porte.hidden = true;
      await connecter();
    } catch (err) {
      gErr.textContent = `Serveur injoignable (${err.message}). Vérifie ta connexion et réessaie.`;
      gErr.hidden = false;
    } finally { bouton.disabled = false; bouton.textContent = "Entrer"; }
  });
  $("#g-local").addEventListener("click", () => { porte.hidden = true; majEtatBd("hors", "Synchronisation désactivée sur cet appareil. Utilise « Changer la clé d’accès » dans Réglages pour la réactiver."); });

  async function demarrer(){
    try {
      const e = await etatAvec(sync.cle);
      if (e.cleRequise && !e.cleValide){
        majEtatBd("cle", "Clé d’accès requise");
        ouvrirPorte(sync.cle ? "La clé enregistrée sur cet appareil n’est plus acceptée." : "");
        return;
      }
    } catch {}
    connecter();
  }

  if (exemple) showBanner("Ce sont des vidéos d’exemple. Dépose ton export TikTok pour les remplacer par les tiennes.");
  buildYears(); render(); remplirReglages();
  demarrer();
})();
