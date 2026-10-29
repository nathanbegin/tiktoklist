# Vidéothèque TikTok

Dépose ton export TikTok (JSON ou ZIP), récupère les légendes de tes favoris et vidéos aimées, puis cherche par mot-clé, #hashtag, @créateur ou année. Avec une base Neon branchée, la bibliothèque et les réglages se retrouvent sur tous tes appareils.

## Fichiers

- `index.html`, `app.js` : l'application. Copie locale dans le navigateur (localStorage), synchronisée avec la base quand elle est connectée.
- `api/video.js` : lit la page publique de chaque vidéo TikTok (plan B : lecteur `embed/v2`). Lots de 100 IDs max, 1 à 12 requêtes simultanées (`conc`), arrêt après ~50 s.
- `api/bibliotheque.js` : lecture incrémentale (curseur), ajout/fusion, remise à zéro de la bibliothèque.
- `api/reglages.js` : réglages partagés entre appareils.
- `api/etat.js` : indique si la base est branchée et si la clé d'accès est valide.
- `lib/commun.js` : connexion Neon, création automatique des tables, vérification de la clé.

## Configuration Vercel

| Variable | Rôle |
|---|---|
| `DATABASE_URL` | Ajoutée automatiquement par l'intégration Neon (base `neon-tiktoklist`). Une variable préfixée comme `NEON_TIKTOKLIST_DATABASE_URL` est aussi reconnue. |
| `ACCES_CLE` | **Recommandée.** Mot de passe de ton choix. Sans elle, n'importe qui qui trouve l'URL peut lire ou vider ta bibliothèque. Entre la même valeur dans Réglages sur chaque appareil. |

Les tables (`videos`, `config`) sont créées au premier appel ; aucune migration à lancer.

Après avoir ajouté ou modifié une variable, redéploie le projet pour qu'elle soit prise en compte.

## Réglages (dans l'application)

Taille des lots, requêtes simultanées, pause entre les lots, délais de nouvel essai (premier délai, multiplicateur, maximum) et nombre d'essais si le serveur ne répond pas. Ils s'appliquent dès le lot suivant.
