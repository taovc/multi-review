<div align="center">
  <img src="public/logo.svg" width="64" height="64" alt="Multi Review" />
  <h1>Multi Review</h1>
  <p>Atelier local de revue de PR en batch · agent Claude au cœur (terminal), web pour le contrôle humain et la gestion d'état</p>
</div>

<div align="center">

[中文](README.md) · **Français** · [English](README.en.md)

</div>

---

Fini la revue des PR une par une dans le terminal : on importe les PR d'un dépôt et on les coche en masse → l'IA audite chacune dans un git worktree isolé en **lecture seule** → tu valides les findings et écris tes retours dans le web → les commentaires ligne-à-ligne + le résumé partent sur GitHub → recheck en un clic après les modifs de l'auteur. Chaque projet dispose de sa propre méthodologie de revue (skill) et de son modèle/effort.

## Fonctionnalités

**Atelier PR**
- Import direct de la liste des PR d'un dépôt (`gh pr list`, pagination par curseur GraphQL, 20 par page), filtrage par état (en cours / mergée / fermée / toutes) et par auteur.
- Coche plusieurs PR pour créer une tâche de revue en un clic ; le drawer de droite affiche le détail de la PR (timeline / diff des modifs), commentaires et description rendus en markdown.
- Deux onglets « Toutes les PR » et « Tâches de revue » ; la liste des tâches se rafraîchit automatiquement (polling), les changements d'état apparaissent sans rafraîchir à la main.

**Revue IA**
- L'agent audite en **lecture seule** dans un git worktree isolé (avec accès `git`/`grep` via Bash filtré), et produit des findings structurés (sévérité + `path:line` + problème / détail / correctif) + une description du besoin + un parcours de test manuel.
- Journal de progression en temps réel (SSE, ligne par ligne comme dans un terminal) ; progression et résultats persistés en base.
- **Revue guidée par tes retours** : tes coches et tes notes sont conservées ; l'IA refait une passe ciblée en suivant chaque note + instruction de revue, et répond finding par finding (maintenu / retiré / ajusté / à discuter).
- **Recheck des modifs de l'auteur** : lit les nouveaux commits poussés après ton commentaire et juge chaque finding (corrigé / partiel / non traité).

**Contrôle humain + publication**
- Coche par finding « publier en commentaire de PR » + ajout d'une note (la note sert d'instruction d'édition intégrée au commentaire, elle n'est pas divulguée telle quelle).
- Aperçu avant publication (dry-run, pouvant être mis en cache / régénéré) ; les findings en chinois sont automatiquement traduits en anglais professionnel ; les commentaires ligne-à-ligne sont rattachés aux lignes de code, ceux qui ne peuvent pas l'être passent dans le résumé.
- La publication passe par `gh api .../reviews`, avec auto-réparation des pending reviews résiduels.

**Configuration par projet**
- Modèle + effort de revue lus directement depuis le `claude` connecté localement (`supportedModels()`), avec les mêmes descriptions que la CLI.
- Plusieurs skills de revue, une seule active à la fois ; **génération / enrichissement par l'IA** : lecture des docs + de l'architecture du dépôt local pour générer une méthodologie adaptée au projet (avec possibilité d'intervenir via des instructions personnalisées), enregistrée comme nouveau candidat puis comparée en diff avant activation — jamais d'écrasement.

**Sécurité & cohérence**
- Agent de revue en lecture seule : interception matérielle au niveau des outils des écritures git / modifications de fichiers / accès réseau / commandes dangereuses (pas via le prompt, blocage physique) + contrat d'opération prioritaire + contrôle de cohérence des skills.
- Opérations git mutuellement exclusives sur un même dépôt (évite les conflits de références lors de `fetch` concurrents) ; écriture des findings en transaction ; suppression d'une tâche nettoie le worktree associé ; reprise des tâches interrompues au redémarrage du service.
- Toutes les opérations destructives (suppression de projet / de tâche, nettoyage) passent par une boîte de confirmation interne au projet, pas par les pop-ups natifs du navigateur.

## Stack technique

Nuxt 4 + @nuxt/ui (Tailwind v4, style minimaliste monochrome) · better-sqlite3 + drizzle · `@anthropic-ai/claude-agent-sdk` (avec outils git, `cwd=worktree`) · `gh` CLI local.

## Prérequis

- Node ≥ 22, pnpm 9
- `gh auth login` effectué (toutes les lectures/écritures GitHub passent par là)
- `claude` connecté localement (utilise l'abonnement, quasiment aucun coût API supplémentaire) ou bien renseigner `ANTHROPIC_API_KEY`

## Installation

Guide pas-à-pas pour une première mise en route. Voir « Démarrage » plus bas pour la version condensée.

**1. Vérifier les prérequis**

```bash
node -v      # ≥ 22
pnpm -v      # 9.x  (sinon : corepack enable && corepack prepare pnpm@9 --activate)
gh --version
gh auth status   # doit indiquer « Logged in » ; sinon : gh auth login
```

Vérifier aussi que la CLI `claude` est connectée localement (elle utilise votre abonnement, quasiment aucun coût API). À défaut, vous fournirez une `ANTHROPIC_API_KEY` à l'étape 3.

**2. Récupérer le projet**

```bash
git clone <url-du-dépôt>
cd multi-review
```

**3. Configurer l'environnement**

```bash
cp .env.example .env
```

Toutes les variables ont des valeurs par défaut raisonnables ; en pratique vous n'ajustez que :

| Variable | Quand la modifier |
|---|---|
| `PORT` | Si `3001` est déjà occupé |
| `INFERENCE_PROVIDER` | `claude` (abonnement local, par défaut) ou `anthropic-api` |
| `ANTHROPIC_API_KEY` | **Uniquement** en mode `anthropic-api`, ou si `claude` n'est pas connecté localement |

Le détail de toutes les variables est dans la section [Configuration (.env)](#configuration-env).

**4. Installer les dépendances**

```bash
pnpm install
```

Le `postinstall` lance automatiquement `nuxt prepare` (génération des types Nuxt).

**5. Premier lancement**

```bash
pnpm dev      # http://localhost:3001
```

Au premier démarrage, **la base SQLite (`./data/cockpit.db`) et le dossier des worktrees (`./data/worktrees`) sont créés automatiquement** — aucune migration manuelle à lancer. Le schéma Drizzle est monté à la volée (`ensureSchema()` / `ensureColumns()` dans `core/db/client.ts`).

**6. Build de production (optionnel)**

```bash
pnpm build
pnpm preview
```

**Dépannage**

- **Port déjà utilisé** → changer `PORT` dans `.env`.
- **`gh` non authentifié** → `gh auth login` (les lectures/écritures GitHub en dépendent).
- **Inspecter la base** → `pnpm db:studio` (ouvre Drizzle Studio).

## Démarrage

```bash
cp .env.example .env      # ajuster au besoin PORT / modèle / chemins
pnpm install
pnpm dev                  # par défaut http://localhost:3001
```

Une fois dedans, clique sur le « ＋ » à gauche pour créer un projet (renseigne `owner/repo` + le chemin du clone local), va dans la configuration du projet pour « générer par l'IA » une skill de revue et l'activer, puis retourne dans « Toutes les PR » pour cocher des PR et lancer la revue.

## Configuration (.env)

Voir `.env.example` ; éléments clés :

| Variable | Exemple | Description |
|---|---|---|
| `PORT` | `3001` | Port |
| `INFERENCE_PROVIDER` | `claude` | `claude` (abonnement local) / `anthropic-api` |
| `ANTHROPIC_MODEL` | `sonnet` | Modèle de revue par défaut (surchargeable par projet) |
| `CODEX_MODEL` |  | Modèle par défaut des projets Codex ; vide = défaut Codex |
| `CODEX_SERVICE_TIER` |  | Optionnel, niveau de vitesse Codex/OpenAI par défaut global ; le bouton Fast au niveau projet le remplace. Pour désactiver fast globalement, laissez vide/supprimez-le et retirez aussi `service_tier` de `~/.codex/config.toml` s'il est défini globalement |
| `CODEX_PROJECT_DOC_FALLBACK_FILENAMES` | `CLAUDE.md,.claude/CLAUDE.md` | Fichiers projet lus par Codex si `AGENTS.md` est absent |
| `TRANSLATE_MODEL` | `sonnet` | Modèle léger pour la traduction chinois→anglais à la publication |
| `ANTHROPIC_API_KEY` | `sk-ant-...` | Uniquement en mode api ou si non connecté localement |
| `DEFAULT_REPO` | `owner/repo` | Optionnel, dépôt par défaut quand on colle un numéro de PR brut |
| `DB_PATH` | `./data/cockpit.db` | Chemin SQLite |
| `REPOS_DIR` | `./data/worktrees` | Racine où atterrissent les git worktrees des revues |
| `MAX_CONCURRENCY` | `3` | Nombre maximum de revues en parallèle |

## Arborescence

```
core/      Moteur : db / github / git(worktree) / agent(review·recheck·skillgen·capabilities·guard·jsonSalvage) / pipeline / queue / events / skillLint
server/    API Nuxt : projects / reviews / skills / agent(capabilities) / SSE / plugin de reprise au démarrage
app/       UI : navigation projets à gauche ; page projet (Toutes les PR / Tâches de revue / Configuration) ; drawer PR (Revue IA / Timeline / Modifs)
docs/      ARCHITECTURE.md — objectifs de design + invariants + mécanismes de sécurité
data/      SQLite + worktrees (ignorés par git)
```

Objectifs de design, invariants et défenses de sécurité détaillés dans [docs/ARCHITECTURE.fr.md](docs/ARCHITECTURE.fr.md).
