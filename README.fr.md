<div align="center">
  <img src="public/logo.svg" width="64" height="64" alt="Multi Review" />
  <h1>Multi Review</h1>
  <p>Cockpit local IA pour PR · revue en batch, chat de correction, développement de feature et assistant global avec Claude/Codex</p>
</div>

<div align="center">

[中文](README.md) · **Français** · [English](README.en.md)

</div>

---

Fini la revue des PR une par une dans le terminal, et fini les corrections dispersées entre plusieurs shells. On importe les PR d'un dépôt → l'IA audite, recheck, corrige ou développe dans des worktrees isolés → tu valides les findings, conversations, diffs, pushs et créations de PR dans le web → GitHub reste la couche externe partagée. Chaque projet peut choisir Claude ou Codex avec son modèle, son effort et sa méthodologie.

## Fonctionnalités

**Atelier PR et revue**
- Import direct de la liste des PR via `gh` / GraphQL, avec filtres par auteur, état PR, état de revue, état de correction et état de worktree.
- Le drawer de droite affiche revue IA, correction, timeline et diff ; descriptions et commentaires sont rendus en markdown.
- L'IA audite en lecture seule dans un git worktree isolé et produit des findings structurés : sévérité, `path:line`, problème, détail et piste de correction.
- La re-revue guidée conserve tes coches/notes ; le recheck après push de l'auteur relit les derniers commits et juge chaque finding.

**Contrôle humain + publication**
- Coche par finding « publier en commentaire de PR » + ajout d'une note (la note sert d'instruction d'édition intégrée au commentaire, elle n'est pas divulguée telle quelle).
- Aperçu avant publication (dry-run, pouvant être mis en cache / régénéré) ; les findings rédigés dans n'importe quelle langue de travail sont réécrits en anglais professionnel pour GitHub.
- La publication passe par `gh api .../reviews`, avec claim `posting` et auto-réparation des pending reviews résiduels.

**Correction de PR**
- Le tab de correction est un chat persistant : l'agent modifie le worktree de la PR, mais ne commit/push pas par défaut.
- « Commit and upload » affiche d'abord le diff et un message de commit conventionnel éditable ; la confirmation seule lance `git add/commit/push`.
- Stop/reprise, logs d'exécution, cartes de décision, ultracode persistant et interrupteur de commandes dangereuses sont pris en charge.

**Développement de feature et assistant global**
- Le tab « Feature development » crée un worktree de feature isolé depuis un besoin et laisse l'agent développer dans une boucle de chat native.
- Les vrais points de décision sont rendus en cartes `ask-user`. L'ouverture de PR est une action explicite qui autorise commit, push et `gh pr create` pour ce tour.
- L'assistant global en bas à droite hérite du provider/cwd du projet quand c'est possible et prend en charge `/cd`, `/resume`, `/clear`.

**Configuration par projet**
- Chaque projet choisit Claude ou Codex. Revue, correction, recheck, génération de skill et réécriture de publication suivent ce provider sans mélanger sessions ni modèles.
- Les modèles Claude viennent du `claude` local ; Codex utilise des modèles prédéfinis/par défaut. Effort, Codex Fast/service tier et méthodologie sont configurables par projet.
- Plusieurs skills de revue, une seule active à la fois ; la génération IA lit les docs et l'architecture du dépôt local, crée un candidat et permet une comparaison diff avant activation.

**Sécurité & cohérence**
- Les agents de revue restent en lecture seule : blocage outil des écritures git, edits de fichiers, accès réseau et commandes dangereuses, avec contrat d'opération et lint de skill.
- Les chemins capables d'écrire tournent dans des worktrees isolés ; push, création de PR et commandes dangereuses exigent une action UI ou un interrupteur explicite.
- Les opérations git d'un même dépôt sont sérialisées ; les findings sont transactionnels ; les tâches supprimées nettoient leurs worktrees ; le redémarrage récupère ou stoppe les travaux interrompus.
- L'automatisation PR est risquée et désactivée par défaut ; activée, elle réutilise les endpoints review/post/fix/push depuis un poller serveur.

## Stack technique

Nuxt 4 + @nuxt/ui (Tailwind v4) · better-sqlite3 + drizzle · `@anthropic-ai/claude-agent-sdk` · `@openai/codex-sdk` · `gh` CLI local · packaging Electron qui lance Nitro via le mode Node d'Electron.

## Prérequis

- Node ≥ 22, pnpm 9
- `gh auth login` effectué (toutes les lectures/écritures GitHub passent par là)
- Provider Claude : `claude` connecté localement ou `ANTHROPIC_API_KEY`
- Provider Codex : connexion Codex locale ou `OPENAI_API_KEY`

## Installation

Guide pas-à-pas pour une première mise en route. Voir « Démarrage » plus bas pour la version condensée.

**1. Vérifier les prérequis**

```bash
node -v      # ≥ 22
pnpm -v      # 9.x  (sinon : corepack enable && corepack prepare pnpm@9 --activate)
gh --version
gh auth status   # doit indiquer « Logged in » ; sinon : gh auth login
```

Vérifier aussi que le provider prévu est disponible : Claude nécessite une connexion `claude` locale ou `ANTHROPIC_API_KEY` ; Codex nécessite une connexion Codex locale ou `OPENAI_API_KEY`.

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
| `INFERENCE_PROVIDER` | `claude` (par défaut) ou `codex` |
| `ANTHROPIC_API_KEY` | Optionnel pour le chemin Claude ; à utiliser si la connexion locale `claude` n'est pas disponible |
| `OPENAI_API_KEY` | Si la connexion locale Codex n'est pas disponible et que vous voulez utiliser une clé OpenAI |

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

Au premier démarrage, **la base SQLite (`./data/cockpit.db`) est créée automatiquement**. Par défaut, les worktrees sont placés dans `.pr-cockpit-worktrees/` à l'intérieur de chaque clone local de projet, afin que l'IDE puisse les détecter comme des worktrees locaux classiques (VS Code exige `git.repositoryScanMaxDepth` à `2` ou `-1` ; la valeur par défaut 1 ne scanne qu'un niveau). Ce répertoire est ajouté au `.git/info/exclude` du projet, ce qui garde propre le `git status` du dépôt principal. La récupération au démarrage déplace les anciens worktrees persistants depuis `./data/worktrees` quand ils existent encore. Aucune migration manuelle à lancer. Le schéma Drizzle est monté à la volée (`ensureSchema()` / `ensureColumns()` dans `core/db/client.ts`).

**6. Build de production (optionnel)**

```bash
pnpm build
pnpm preview
```

Prévisualisation / packaging Electron :

```bash
pnpm electron:preview
pnpm electron:dist
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

Une fois dedans, clique sur le « ＋ » à gauche pour créer un projet (renseigne `owner/repo` + le chemin du clone local), configure provider/model/effort et génère une skill de revue. Utilise ensuite « Toutes les PR » pour revue/correction, ou « Feature development » pour créer des worktrees de feature.

## Configuration (.env)

Voir `.env.example` ; éléments clés :

| Variable | Exemple | Description |
|---|---|---|
| `PORT` | `3001` | Port |
| `INFERENCE_PROVIDER` | `claude` | `claude` / `codex` |
| `ANTHROPIC_MODEL` | `sonnet` | Modèle de revue par défaut (surchargeable par projet) |
| `CODEX_MODEL` |  | Modèle par défaut des projets Codex ; vide = défaut Codex |
| `CODEX_SERVICE_TIER` |  | Optionnel, niveau de vitesse Codex/OpenAI par défaut global ; le bouton Fast au niveau projet le remplace. Pour désactiver fast globalement, laissez vide/supprimez-le et retirez aussi `service_tier` de `~/.codex/config.toml` s'il est défini globalement |
| `CODEX_PROJECT_DOC_FALLBACK_FILENAMES` | `CLAUDE.md,.claude/CLAUDE.md` | Fichiers projet lus par Codex si `AGENTS.md` est absent |
| `OPENAI_API_KEY` | `sk-...` | Optionnel si la connexion locale Codex n'est pas disponible |
| `TRANSLATE_MODEL` | `sonnet` | Modèle léger pour réécrire les commentaires GitHub en anglais |
| `ANTHROPIC_API_KEY` | `sk-ant-...` | Optionnel pour le chemin Claude si la connexion locale n'est pas disponible |
| `DEFAULT_REPO` | `owner/repo` | Optionnel, dépôt par défaut quand on colle un numéro de PR brut |
| `DB_PATH` | `./data/cockpit.db` | Chemin SQLite |
| `WORKTREE_LOCATION` | `repo` | `repo` = `.pr-cockpit-worktrees/` visible par l'IDE dans chaque clone local ; `central` = utiliser `REPOS_DIR` |
| `REPOS_DIR` | `./data/worktrees` | Racine des worktrees en mode `central` ; source de migration legacy en mode `repo` |
| `MAX_CONCURRENCY` | `3` | Nombre maximum de revues en parallèle |

## Arborescence

```
core/      Moteur : db / github / git(worktree) / agent(review·fix·feature·global·codex·skillgen) / automation / pipeline / events
server/    API Nuxt : projects / reviews / fixes / features / global sessions / skills / SSE / plugin de reprise au démarrage
app/       UI : navigation projets ; page projet (Feature development / Toutes les PR / Configuration) ; drawer PR (Revue IA / Correction / Timeline / Modifs)
electron/  Shell desktop : démarre Nitro et charge l'UI HTTP locale
docs/      ARCHITECTURE.md — objectifs de design + invariants + mécanismes de sécurité
data/      SQLite + worktrees (ignorés par git)
```

Objectifs de design, invariants et défenses de sécurité détaillés dans [docs/ARCHITECTURE.fr.md](docs/ARCHITECTURE.fr.md).
