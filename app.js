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
  const saveSync = () => { ecrire(KEY + "-sync", sync); ecrire(KEY + "-apousser", [...aPousser]); };

  async function api(chemin, opts = {}){
    const r = await fetch(chemin, { ...opts, headers: { "Content-Type":"application/json", "x-cle": sync.cle || "", ...(opts.headers||{}) } });
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
      try {
        const parId = new Map(lib.map(v => [v.id, v]));
        while (aPousser.size){
          const ids = [...aPousser].slice(0, 2000);
          const videos = ids.map(id => parId.get(id)).filter(Boolean);
          if (videos.length) await api("/api/bibliotheque", { method:"POST", body: JSON.stringify({ videos }) });
          ids.forEach(id => aPousser.delete(id));
          saveSync();
        }
        majEtatBd("ok");
      } catch (e) { majEtatBd("erreur", e.message); throw e; }
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
      let nouv = 0, premier = true;
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
      majEtatBd("ok");
      return nouv;
    } catch (e) { majEtatBd("erreur", e.message); throw e; }
  }

  async function connecter(){
    majEtatBd("verif");
    let e;
    try { e = await api("/api/etat"); }
    catch { bd.active = false; majEtatBd("hors", "Serveur injoignable."); return; }
    if (!e.bd){ bd.active = false; majEtatBd("hors", "Aucune base de données configurée sur le serveur."); return; }
    if (e.cleRequise && !e.cleValide){ bd.active = false; majEtatBd("cle", sync.cle ? "Clé d’accès refusée." : "Entre la clé d’accès pour synchroniser."); return; }
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
    const cap = v.statut === "ok" ? `<p class="cap">${highlight(v.legende) || '<span class="cap vide">Sans légende</span>'}</p>`
      : `<p class="cap vide">${v.statut === "indisponible" ? "Vidéo supprimée ou privée" : "Légende pas encore récupérée"} · ID ${v.id}</p>`;
    return `<article class="card">
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
      try {
        data = await api(`/api/video?ids=${lot.map(v => v.id).join(",")}&conc=${R.conc}`);
        echecs = 0;
      } catch (e) {
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
  function remplirReglages(){ for (const k of champs) $("#r-" + k).value = reglages[k]; $("#r-cle").value = sync.cle || ""; apercu(); }
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
  $("#r-form").addEventListener("submit", async ev => {
    ev.preventDefault();
    reglages = lireForm(); ecrire(KEY + "-reglages", reglages); remplirReglages();
    const cle = $("#r-cle").value.trim();
    const cleChangee = cle !== (sync.cle || "");
    if (cleChangee){ sync.cle = cle; saveSync(); }
    dlg.close();
    showBanner("Réglages enregistrés.");
    updateEnrich();
    if (cleChangee || !bd.active) await connecter();
    if (bd.active) api("/api/reglages", { method:"PUT", body: JSON.stringify({ reglages }) }).catch(e => majEtatBd("erreur", e.message));
  });
  $("#r-sync").addEventListener("click", async () => {
    if (!bd.active) await connecter();
    else { try { await pousser(); await tirer(); } catch {} }
  });

  // Resynchroniser quand on revient sur l'onglet
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && bd.active && !enCours) tirer().then(() => pousser()).catch(() => {});
  });

  if (exemple) showBanner("Ce sont des vidéos d’exemple. Dépose ton export TikTok pour les remplacer par les tiennes.");
  buildYears(); render(); remplirReglages();
  connecter();
})();
