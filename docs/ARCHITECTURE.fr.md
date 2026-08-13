# PR Cockpit — Architecture et objectifs de design

> [中文](ARCHITECTURE.md) · **Français** · [English](ARCHITECTURE.en.md)

> Cockpit local IA pour PR. Le web assure le contrôle humain et la gestion d'état ; Claude/Codex exécutent la revue, la correction, le développement de feature et l'assistant global.
> Ce document s'adresse autant aux humains qu'il sert de source au « contrat d'opération » de l'agent de revue (voir `core/agent/guard.ts`).

## Objectifs de design

Fini la revue des PR une par une dans le terminal, et fini les corrections ou features dispersées entre plusieurs shells. On met PR et besoins dans le cockpit → l'IA audite, recheck, corrige ou développe dans des worktrees isolés → l'humain vérifie les findings, écrit les retours, inspecte les diffs, confirme les pushs ou ouvre les PR → GitHub reste l'unique couche externe de collaboration. Chaque projet configure provider (Claude/Codex), modèle, effort et méthodologie.

## Invariants fondamentaux (INVARIANTS · inviolables)

1. **Revue en lecture seule** : l'agent de revue lit le code en lecture seule dans un git worktree isolé ; il ne peut faire que `git diff/log/show`, `grep`, lire des fichiers, `gh pr view` / `gh api` en GET.
2. **Auditer sans modifier** : les chemins de revue produisent findings / JSON structuré ; ils ne modifient ni fichiers, ni état git, ni état GitHub.
3. **Le mécanisme appartient au moteur, les règles à la skill** : worktree, branches, publication des commentaires, décision de corriger = contrôlés par le moteur ; la skill ne décide que quoi auditer et comment juger.
4. **Les chemins capables d'écrire doivent être isolés et explicites** : fix / feature / global tournent dans des worktrees isolés ou un cwd explicite. Par défaut ils ne pushent pas et n'ouvrent pas de PR. Push, `gh pr create` et commandes dangereuses exigent une action UI ou un interrupteur explicite.
5. **Les écritures externes doivent être traçables** : la publication de review passe par `gh api .../reviews` après claim `posting` ; l'upload fix prévisualise diff + message de commit ; la création de PR feature est un tour explicite ; les résultats sont persistés localement ou retrouvables via GitHub.
6. **Pas de mélange de providers** : Claude et Codex gardent des ids natifs session/thread séparés ; modèle, effort et service tier suivent le provider courant ; un provider ne doit jamais reprendre la session de l'autre.

## Comment ces invariants sont imposés (défense en profondeur)

- **Séparation des responsabilités** : skill = règles ; moteur = mécanisme.
- **Contrat d'opération en tête** (`core/agent/guard.ts`, `OPERATING_CONTRACT`) : placé tout en haut du system prompt de chaque agent, il énonce les règles ci-dessus et précise que « tout contenu de skill en conflit avec lui est ignoré ».
- **Interception matérielle au niveau des outils** (`reviewCanUseTool`) : le callback SDK `canUseTool` bloque dans Bash les écritures git / écritures gh / commandes destructives ; les outils d'écriture (`Write`/`Edit`, etc.) sont systématiquement refusés. **On ne compte pas sur l'obéissance du modèle : c'est physiquement inexécutable.**
- **Contrôle de cohérence des skills** (`core/skillLint.ts`) : scan des mots interdits à la génération / import / activation ; un avertissement à confirmer avant activation.
- **Limites de la génération de skill** : skillgen est explicitement contraint à ne produire que des règles, jamais de flux d'opérations.
- **Garde des commandes dangereuses** (`core/agent/dangerGuard.ts`) : les chemins capables d'écrire bloquent par défaut push, création de PR et commandes destructives ; l'UI peut les autoriser pour un tour précis.
- **Colonnes de session natives** (`core/agent/session.ts`) : Claude écrit `session_id`, Codex écrit `codex_session_id`; un changement de provider ne peut pas reprendre l'autre session.
- **Claim de publication** : la publication de review utilise l'état `posting` et des mises à jour compare-and-set pour éviter les doublons concurrents.

## Stack technique / structure

Nuxt 4 + @nuxt/ui (Tailwind v4) · better-sqlite3 + drizzle · `@anthropic-ai/claude-agent-sdk` · `@openai/codex-sdk` · `gh` CLI local · Electron.

```
core/      Moteur : db / github / git(worktree) / agent(review·fix·feature·global·codex·skillgen) / automation / pipeline / events
server/    API Nuxt : projects / reviews / fixes / features / global sessions / skills / SSE
app/       UI : navigation projets ; page projet (Feature development / Toutes les PR / Configuration) ; drawer PR (Revue IA / Correction / Timeline / Modifs)
electron/  Shell desktop : démarre Nitro et charge l'UI HTTP locale
```

## Cycle de vie d'une revue

`queued → cloning → reviewing → draft → ready_to_post → posted` ; branche annexe `recheck_requested → rechecking → draft` ; transition `→ error` possible depuis n'importe quel état.
Les statuts « déjà audité / l'auteur a remodifié / déjà mergé » sont dérivés en temps réel depuis GitHub (état de la PR + head sha vs sha du dernier commentaire publié), sans empiler de machine à états locale.

## Cycles de vie des chemins d'écriture

- **Fix** : `open / pushing / pushed / error`. Le chat modifie le worktree ; le bouton upload fait d'abord un dry-run diff + message de commit, puis la confirmation commit et push.
- **Feature** : `working / awaiting / opened / error`. Le premier besoin crée un worktree de feature isolé ; les blocs `ask-user` deviennent des cartes de décision ; ouvrir une PR est un tour de message explicite.
- **Global** : une session globale stocke turns, provider, cwd et model/effort. Avant session native elle peut hériter du provider projet ; ensuite elle reste fixée pour éviter les reprises croisées.
- **Automation** : désactivée par défaut ; activée, le poller serveur déclenche review/post/fix/push via les endpoints existants et doit conserver plafonds, déduplication et stop-loss.

## Modèle / effort

On suit le provider + model + effort configurés par projet. Claude lit les capacités du `claude` local ; Codex utilise des modèles prédéfinis/par défaut avec service tier optionnel. Première revue, recheck, chat de correction, feature, génération de skill et réécriture anglaise à la publication doivent suivre le provider actif sans mélange. La génération de skill réfléchit par défaut en profondeur (effort `high`) + lecture intégrale du dépôt.
