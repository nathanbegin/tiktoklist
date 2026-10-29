# Vidéothèque TikTok

Dépose ton export TikTok (JSON ou ZIP), récupère les légendes de tes favoris et vidéos aimées, puis cherche par mot-clé, #hashtag, @créateur ou année.

- `index.html` : l'application (tout se passe dans le navigateur ; la bibliothèque est gardée en localStorage).
- `api/video.js` : fonction Vercel qui lit la page publique de chaque vidéo TikTok (plan B : lecteur intégré `embed/v2`) par lots de 100 IDs (les plus récentes en premier).

Déploiement : `vercel deploy --prod` depuis ce dossier, ou importer le dossier dans un nouveau projet Vercel (préréglage « Other », aucune commande de build).
