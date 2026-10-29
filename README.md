# Vidéothèque TikTok

Dépose ton export TikTok (JSON ou ZIP), récupère les légendes de tes favoris et vidéos aimées, puis cherche par mot-clé, #hashtag, @créateur ou année.

- `index.html` : l'application (tout se passe dans le navigateur ; la bibliothèque est gardée en localStorage).
- `api/oembed.js` : fonction Vercel qui interroge l'oEmbed public de TikTok par lots de 50 IDs (les plus récentes en premier).

Déploiement : `vercel deploy --prod` depuis ce dossier, ou importer le dossier dans un nouveau projet Vercel (préréglage « Other », aucune commande de build).
