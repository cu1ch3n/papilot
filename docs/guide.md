# Papilot guide

The complete manual: installing and running Papilot, every part of the workspace, remote access, configuration and development. For a short introduction, see the [README](../README.md).

Papilot is a personal workspace for revising LaTeX papers with an AI agent (Codex, Claude, Antigravity or Kimi Code) and reviewing the resulting PDF changes. Run it on your host computer and continue from a desktop, tablet, or phone.

The interface is in English or Simplified Chinese: **Settings → Language** follows the browser by default and can be set to either. The messages Papilot sends the agent and the documentation are in English, and Codex defaults to English updates and questions. Your manuscript, project names, comments, and conversation history retain their original language.

Built with TypeScript, React/Vite, Fastify, SQLite, the official Codex app-server over stdio, the Claude Agent SDK, the Antigravity CLI, and Kimi Code CLI over ACP.

## Install and run

Papilot needs Node.js 22.22+, Git, a working TeX installation with `latexmk` and `synctex`, and at least one signed-in agent on the host.

```sh
npm install -g papilot
papilot demo   # add the example paper, then start
papilot        # start
```

The `papilot` command keeps its state in `~/.papilot`; `--data <folder>` (or `PAPILOT_DATA`) chooses another folder and `--port <number>` (or `PAPILOT_PORT`) another port. `papilot --help` lists every option.

To run from a source checkout instead:

```sh
npm ci
npm run setup:review
npm run build
npm start
```

A source checkout keeps its state in `.papilot` inside the checkout, and `npm run demo` adds the example paper.

Open [Papilot](http://127.0.0.1:7274) and select **Add paper**. Choose a folder, drop a LaTeX ZIP, or expand **Use a folder on this computer** to enter a host path. Uploaded folders and ZIPs are copied into the Papilot data folder (`papers/`); a host path uses the original files. Uploads support up to 64 MB and 5,000 files. Later papers are added and switched from the paper menu at the top of the sidebar.

Papilot identifies the main TeX file and compiler, creates Git history when needed, and attempts compilation automatically. If the main document is ambiguous, choose it before compiling. Existing repositories keep their commits and staged changes; new repositories receive a local initial commit without requiring Git identity setup. The main-file and engine selections are saved in `.latex-review.json`.

A failed build stays in the import window with compiler details and suggested next steps. Change the main file or engine and retry, edit files at the displayed saved location, or choose **Help fix compilation** with a connected assistant. Assistant repairs remain uncommitted for inspection in file changes. Missing TeX tools must be installed on the host. **Continue later** saves the import for the next time you open **Add paper**, including after a restart. **Add and fix later** registers a prepared paper even if compilation still needs attention; PDF review requires a successful build. Closing or replacing an import keeps its saved files. Custom build settings are described in the [review engine reference](../vendor/latex-review/docs/reference.md).

Each paper in that menu has a **pencil** button that opens its name and repository path together, with **Remove paper** in the same dialog. You can manage a paper without switching to it. Changing the path updates its saved repository location and checks that any existing task worktrees belong to that repository; it does not move files. Removing a paper clears its Papilot tasks, conversations, notes and sharing entries while preserving all files, Git history and worktrees on disk. Path changes and removal are owner-only and require the paper's current tasks and builds to be idle.

To try a sample first, run `papilot demo` (`npm run demo` in a source checkout). It copies the example paper in `examples/papilot-paper` (this README written as a 26-page LaTeX paper in fifteen chapter files, with a usage chapter, formal models of review rounds, conflicts, the PDF view's geometry, queueing and Git, theorems with proofs, an algorithm, TikZ and pgfplots figures, tables and a BibTeX bibliography, so there is plenty to review) into a separate Git repository, `example-paper` in the data folder, and registers it as **Papilot paper** without changing an existing manuscript. Start an editing task from the interface when you are ready to use your chosen agent.

Papilot uses the `codex` on your `PATH` when it is version 0.164.0 or newer; otherwise the `papilot` command installs that version into `agents` in the data folder on its first start. Either way Codex uses the host's normal Codex login and configuration. To sign in, run `papilot codex login` on the host. No API key is stored by Papilot. Model selection defaults to the host's configured Codex model.

### Agents

Each task runs on one agent, chosen with **Agent** below the prompt; Papilot remembers the agent, and each agent's model and reasoning effort, for the next task. Papilot looks for every agent when it starts and whenever you select **Reconnect**, and offers only the ones it finds on this host: an installed CLI, or the API key an SDK-based agent needs. Codex is always offered, because Papilot installs it. An agent that is found but not signed in is listed as unavailable and says why. **Settings → Runtime & diagnostics** names the agents that were not found.

CLI agents, including Claude when Claude Code is installed, use their own login and configuration on this host. The SDK-based agents (Cursor, GLM, and Claude without Claude Code) take their key from Papilot's environment and receive it only for their own service. Papilot never stores a credential. Every agent edits only the task's worktree and leaves compiling and publishing the review to Papilot.

- **Codex** runs through the Codex app-server with its workspace-write sandbox. Commands outside the sandbox and Codex's questions come to the conversation for approval.
- **Claude** runs on [Claude Code](https://code.claude.com) when it is installed: each turn is one `claude -p` process with your own Claude Code login, either your Claude plan, whose usage counts toward the plan's limits, or an API key. Sign in once with `claude auth login`. Papilot only reads whether Claude Code is signed in; the credential stays with Claude Code. Edits in the worktree are accepted and commands run in Claude Code's sandbox. `-p` cannot ask for approval, so anything that would need it, such as a write outside the worktree, is declined and noted in the conversation, and Claude asks its questions in its reply. A later turn resumes the same session. The model menu offers Claude Code's aliases (Fable, Opus, Sonnet, Haiku) and their reasoning efforts. Set `PAPILOT_CLAUDE_BIN` if the service cannot find `claude`.

  Without Claude Code, Claude runs through the Claude Agent SDK, which an installed Papilot downloads into `agents` in the data folder the first time it starts with an API key. Through the SDK, anything that needs approval, including Claude's questions, comes to the conversation. The SDK needs an API key: Anthropic does not accept a Claude subscription login through the Agent SDK and refuses such requests with 403. Run Papilot with `ANTHROPIC_API_KEY` set (or with Claude Code configured for Amazon Bedrock, Google Vertex AI or Microsoft Foundry); usage is billed to that key or provider.

  Claude can also run on another service's Anthropic-compatible endpoint. Set `ANTHROPIC_BASE_URL` to the endpoint and `ANTHROPIC_AUTH_TOKEN` (or `ANTHROPIC_API_KEY`) to that service's key, and map the model menu onto the service's models; usage is billed by that service. If the service rejects Anthropic's beta headers, `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` sends only the ones Claude Code needs.

  ```sh
  ANTHROPIC_BASE_URL=https://<service>/anthropic ANTHROPIC_AUTH_TOKEN=<key> \
  ANTHROPIC_DEFAULT_OPUS_MODEL=<model> ANTHROPIC_DEFAULT_SONNET_MODEL=<model> \
  ANTHROPIC_DEFAULT_FABLE_MODEL=<model> ANTHROPIC_DEFAULT_HAIKU_MODEL=<smaller model> \
  CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1 papilot
  ```
- **Cursor** runs a local agent through the [Cursor SDK](https://cursor.com/docs/api/sdk/typescript), which an installed Papilot downloads into `agents` in the data folder the first time Cursor is used. Start Papilot with `CURSOR_API_KEY` set to a key from the Cursor dashboard; the SDK does not use the Cursor app or CLI login, and usage is billed to that key. Cursor runs in its own sandbox: it writes only inside the worktree and temporary folders, and its commands have no network access. The SDK cannot ask for approval, so anything outside the sandbox fails and is noted in the conversation. The model menu comes from your Cursor account, with **Auto** as the default; reasoning effort is offered for models that have it. A restarted Papilot resumes the same Cursor agent.
- **GLM** runs on Claude Code through Zhipu's Anthropic-compatible endpoint, the way Zhipu documents GLM Coding Plan for Claude Code. Start Papilot with `ZHIPU_API_KEY` (open.bigmodel.cn) or `ZAI_API_KEY` (api.z.ai) set to your GLM Coding Plan or API key. It behaves like Claude above, with GLM-5.3, GLM-5.3 Flash, GLM-5 Turbo and GLM-4.7 in the model menu. Claude Code receives only the GLM key: Anthropic keys and cloud-provider settings in Papilot's environment are not passed on.
- **Antigravity** runs `agy -p` with streamed output, one process per turn, and resumes the same agy conversation on later turns. Headless agy cannot ask for permission, so Papilot runs it in accept-edits mode: it reads and edits files in the worktree, while shell commands and edits elsewhere are declined by agy and noted in the conversation. Its models are listed with their effort variants grouped, and your saved agy model is the default. If agy reports that your location is not supported, set `PAPILOT_AGY_PROXY` to an HTTP proxy; it applies only to agy.

- **Kimi Code** runs `kimi acp` using the [official ACP interface](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-acp). Install Kimi Code CLI, run `kimi login`, then choose **Kimi** in the agent menu and select **Reconnect** if Papilot was already running. Papilot reads the model catalog and available thinking levels from the CLI, streams replies and tool activity, forwards tool approvals, sends images as native inputs, and resumes the same session after a restart. It selects manual approval mode; Kimi executes approved tools on the host, without a Papilot sandbox. Credentials stay with Kimi. Set `PAPILOT_KIMI_BIN` to the executable path if the service cannot find `kimi`. Validated with Kimi Code CLI 2.4.1: model discovery, thinking level selection, tool approvals, file writes, streamed replies, and session recovery after restarting the connection. Older CLIs must support ACP and manual approval mode.

- **DeepSeek** runs `dsh acp` from [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Install it with `npm install -g @deepseek-ai/dsh` (Node 22.19 or newer) and set up a model and API key in `dsh web` or the dsh terminal UI first. Papilot pins its `workspace-write` permission preset: writes and commands stay inside the worktree, and anything outside it comes to the conversation for approval. The model and reasoning effort come from dsh; it does not accept images. Set `PAPILOT_DSH_BIN` if the service cannot find `dsh`.
- **Qwen** runs `qwen --acp` from [Qwen Code](https://github.com/QwenLM/qwen-code). Install it and sign in by running `qwen` once. Papilot selects its Auto Edit mode: edits in the worktree go ahead, and shell commands come to the conversation for approval. Set `PAPILOT_QWEN_BIN` if needed.
- **OpenCode** runs `opencode acp`, with the providers and models you connected in [OpenCode](https://opencode.ai) (`opencode auth login`). OpenCode normally runs every tool without asking, so Papilot adds a configuration layer through `OPENCODE_CONFIG_CONTENT`, on top of your own: edits in the worktree go ahead, and shell commands and anything outside the worktree come to the conversation for approval. Set `PAPILOT_OPENCODE_BIN` if needed.

These three, like Kimi, run their approved tools on the host. Each was tested in Papilot with a task that edited the example paper and built its review: OpenCode 2.0.32 (also a command approved from the conversation), DeepSeek Harness 0.2.1-rc.5 (also its approval request for a write outside the worktree) and Qwen Code 0.26.4. The Cursor and GLM adapters are covered by protocol tests only.

## Diagnostics

```sh
papilot doctor
papilot doctor --repo /path/to/paper
papilot doctor --json --data ~/papilot-data --port 4400
```

Doctor checks Node, runtime packages, built frontend and review-engine files, the data directory, Git, `latexmk`, SyncTeX and available TeX engines, and the remote-access and collaborator sign-in settings. With `--repo`, it also checks that the selected folder is the Git root, has an initial commit, has a valid main document and review configuration, and can create task worktrees. It uses the review engine's own configuration loader, without compiling or creating a worktree. Registered papers are not automatically inspected; select the paper explicitly with `--repo`.

Agent checks use the same Codex locations as the installed launcher, check its version and login status, check whether Claude Code is signed in (or, without it, look for a Claude key), look for the Cursor and GLM keys and SDKs in the current environment, ask `agy models` for its model list, and check that the ACP mode of `kimi`, `dsh`, `qwen` and `opencode` is available (without checking their logins). No model prompt is sent. Keys are not validated against the API, and SDK-managed credentials are not inspected. A successful report does not guarantee a model request or a paper build will succeed. Agents that are not found are listed for information only, since Papilot does not offer them; an agent that is found but not working is a warning. PDF reading can still work without any agent. Configure at least one agent for editing.

Doctor also checks the local health endpoint and Tailscale origin/owner settings. On macOS, it compares an installed service's saved tool paths and data directory with the terminal environment. It does not start, stop or reinstall a service. A stopped server or an uninstalled optional service is normal.

Each failed check includes a suggested fix. Exit code **0** means no blocking errors (warnings may remain), **1** means blocking errors, and **2** means invalid command-line options. `--json` writes one object to standard output with `name`, `version`, `ok`, and `checks`; each check contains `id`, `ok`, `severity`, `detail`, and `fix`. Node fallback notices go to standard error. Diagnostics do not install dependencies, create Papilot state, compile papers or change manuscript files. Each external command has a five-second timeout.

From a source checkout, use `npm run doctor -- --data .papilot` (or `node bin/papilot.mjs doctor --data .papilot` if npm dependencies are missing). The CLI default is `~/.papilot`, even in a checkout; specify the data folder used by the instance you are diagnosing. `PAPILOT_DATA`, `PAPILOT_PORT` and the agent overrides are honored; command-line data and port options take precedence.

## Workflow

1. Select **New task**, describe the revision, and press Enter. The first line of the prompt becomes the task title. Instead of writing the whole prompt, you can start from a [skill](#skills): pick one of the suggestions under the prompt, or type `/`, then say where to apply it (or nothing, for the whole paper). The task runs on the paper selected in the sidebar. Below the prompt, choose the Codex model and its reasoning effort: the effort chip opens a slider from the lightest to the deepest reasoning the model supports. Papilot remembers both for the next task, including tasks started from PDF notes; if a remembered model or effort is no longer offered, the host's default is used. The chat header shows the model and effort a task runs with. When the host's Codex login reports usage (a ChatGPT plan), the new-task page also shows each usage window, such as the weekly limit, with how much is used and when it resets, plus the credit balance; it refreshes when Codex reports new usage after a turn.
2. Follow the conversation and answer any Codex questions or permission requests. Extra tasks queue when both execution slots are occupied.
3. When Codex finishes, Papilot builds the PDF review automatically. The review covers the paper's source folder (`source_dir` in `.latex-review.json`), and the agent is told so. If the agent's own edits stop the build, because they touch a file outside that folder, such as a project note, or the LaTeX no longer compiles, Papilot sends the error back to the agent once, and the chat shows it as **Build failed · sent to** the agent. If the next build fails too, the task stops and shows the error. Accept, reject, or comment on individual changes in the viewer. When an edit also changes the PDF away from its own lines, such as the uses of a macro it redefines or the equations renumbered after one it inserts, those places are listed under the edit as **Affects N places**: the first three are shown, and **Show N more** renders the rest. They have no buttons; deciding the edit decides them. Papilot finds them by comparing the two PDFs word by word, and when a round has several edits it compiles the accepted text with some of them to tell which edit causes each change. Accepting a change writes it into the manuscript's working tree, like applying an agent's worktree in Cursor; nothing more is needed. When every change is decided and some are not committed yet, the review's card also offers **Commit…**, which is optional: its dialog lists the files this task accepted since its last commit, and the task's agent writes the message (✨ writes it again, and you can edit it). **Commit** commits exactly those files as they are on disk, so a file that another task's accepted changes also touched carries those too; **Commit and push** then pushes, and if the push fails the commit stays. The card then shows the commit. With only the chat in view, a card at the end of the conversation offers the same. You can also commit from the **Git** panel at any time.
4. If you commented, use **Send feedback** below the PDF review to send your decisions and comments to the agent for another round; it also sends rounds whose changes you all rejected. You can also write further instructions in the conversation panel. Both actions include new review feedback. Sending feedback opens the conversation on a phone, or the split view when reviewing on desktop, while preserving an unsent instruction draft.

While Codex works, the composer shows a stop button that pauses the task; when the chat is hidden, **Pause** appears in the task header instead. The header also keeps status and recovery actions beside the selected task. Choose **Review**, **Split**, or **Chat** for the desktop workspace; choosing a view always shows that view, and the choice is saved in this browser. On phones, switch between **Review** and **Chat** in the header. PDF controls share the review toolbar with the viewer's progress, **Accept all** and **Reject all**: **Full PDF**, **Build review** (the refresh button) to build the review again, and **Open review in new tab**. Each batch button shows how many undecided changes it decides. When the review panel is narrow, the toolbar keeps everything on one line: the progress and the shortcuts button go first, then **Accept all** and **Reject all** show only their icon and count (hover for the full name), **Notes** shows only its icon, and **Open review in new tab** is hidden; on a phone **Build review** is hidden too, since a failed build offers it. The review always fits the panel's width. **Accept all** and **Reject all** apply only to changes you have not decided yet; accepted, rejected and commented changes keep their state, and one undo reverses the whole batch. On phones, the current change's Accept, Reject and Comment bar sits at the bottom of the screen, menus open as bottom sheets, **Full PDF** is in **Review options**, and **Fit** crops the page margins so the text block fills the width. The zoom menu enlarges PDF strips; scroll horizontally to read enlarged content. Real-device keyboard and touch behavior still needs validation on iOS and Android.

Select **PDF** under the paper in the sidebar to read the manuscript as it is on disk, including review changes you accepted but have not committed yet. The viewer is [pdf.js](https://mozilla.github.io/pdf.js/), so it behaves like a local PDF reader: continuous pages with crisp text at any zoom, selectable text, working links and cross-references, and search across the whole document.

- **Contents** lists the PDF's bookmarks (hyperref writes them for every section) with their page numbers and highlights the section you are reading. Select an entry to jump to it, from the panel beside the PDF or from the section menu at the left of the toolbar, which always shows the current section and is the quickest way to move around on a phone.
- Type a page number or use the arrows to change page. Zoom with **−** and **+**, the zoom menu (**Fit width**, **Fit page** or a percentage), ⌘+ / ⌘− / ⌘0, a trackpad pinch or a two-finger pinch on a phone. The zoom is remembered.
- ⌘F (Ctrl+F) or the search button finds text in every page; Enter and Shift+Enter step through the matches.

Beside the PDF, **Git** is a small source-control panel: the branch and how it compares with its upstream, the last commit, and the uncommitted changes with line counts (the sidebar shows a one-line summary). Select a file to read its diff. Tick the files to include, write a message and press Enter or **Commit**; exactly those files are committed as they are on disk, and anything you staged elsewhere for other files stays staged. New build output (LaTeX's `.aux`, `.log`, `.synctex.gz` and the like, minted's `_minted*` cache, and macOS's `.DS_Store`) starts unticked, and when any of it is untracked the panel offers **Add to .gitignore**: one click adds a pattern for each kind of file (such as `*.aux`) to the repository's `.gitignore`, without repeating patterns it already has, and `.gitignore` then appears as a change to commit. The ✨ button in the message box writes the commit message, like Cursor's: the agent chosen on the new-task page reads the ticked files' changes, the titles of the tasks that changed them and the repository's recent commit subjects, whose style and language it follows, and answers in one read-only turn with its lightest reasoning. No file is changed, and Codex does not keep the turn in its history. Edit the message before committing if you like. When the repository has a remote, **Fetch** checks for new commits, **Pull** fast-forwards, and **Push** sends your commits, or **Publish branch** pushes a branch that has no upstream yet. When your branch and its upstream have both moved on, for example after a coauthor pushed from Overleaf, **Merge** takes Pull's place and merges the upstream into your branch (it never rebases). A merge without conflicts commits itself. One with conflicts stops, and the panel shows how many files still have conflict markers (marked **!**): **Resolve with** the agent chosen on the new-task page edits only those files in the manuscript checkout, keeping both sides' changes where they fit and saying where it had to choose, and its summary appears in the panel. Read each file's diff, then **Commit merge**, or **Abort merge** to return to where you were. Until the merge is committed or aborted, accepting, rejecting and undoing review changes, other commits, pull and push are refused with a message saying so. Remote operations use the host's own Git credentials and never prompt; if a credential is missing they fail with Git's message. The PDF recompiles when the working tree changes and reopens at the same page and zoom; **Recompile** retries a failed build and **Open the PDF file** opens the PDF itself. A temporary Git index captures the working tree, so your index, branches and files are not touched. Builds reuse the review engine's cache in the repository's `.git/latex-review` folder. On phones, switch between **PDF**, **Notes** and **Git** in the header.

To ask for changes directly on the PDF, select the text and choose **Add note**, then describe the change and press Enter. Selection follows the printed words exactly: the server reads every word's place from the PDF, and the viewer puts one selectable run on each word (pdf.js on its own lays a whole line out in a stand-in font, which drifts from the printed words mid-line). A drag that starts or ends inside a word takes the whole word; one that starts or ends between words takes just the words it covers. For a figure, an equation or anything else without selectable text, turn on **Mark region** in the toolbar and drag across it. Nothing is recognized from images: the marked text comes from the PDF's own text layer, and SyncTeX, which the TeX engine writes while compiling, maps the first and last marked character of each line back to the LaTeX file and lines that produced them. SyncTeX records spaces rather than characters, so a word that starts a printed line can be credited to the source line before it; Papilot then matches the printed line around each end of the selection against the nearby source lines to settle on the exact lines. Each note stores that location and the source lines themselves, so formulas reach the agent as LaTeX rather than as extracted PDF text, and the note stays meaningful after the PDF recompiles. Notes are shared across devices, highlighted on the page with a numbered tag in the margin, and listed under **Notes** with their LaTeX source; select a number to find it on the page or × to delete it. **Send notes to the agent** turns every pending note into one new task that quotes each marked passage and its source location, and opens that task.

Titles (the brand, paper names, task and page headings) use the manuscript's TeX Gyre Pagella; the rest of the interface uses the system sans, and code uses Inconsolata. The fonts are bundled in `src/web/fonts` with their licenses. Colours are clean neutral greys with one blue (#2563EB) for primary actions, links and selection, and green and red only where they mean accept and reject; the embedded review viewer uses the same palette. **Settings** at the bottom of the sidebar chooses the **Appearance**, **Light**, **Dark** or **System**; the choice is saved in this browser, applies before the page first paints, and the review viewer follows it. In the dark theme PDF pages turn dark too, in the review and in the PDF view: their lightness is inverted and their hue kept, so removed and added text stay red and green and links stay blue. Figures are inverted the same way, and Notes and search marks keep their colours.

**Send feedback** appears while review comments have not been sent to the agent, and after a round in which you rejected every change. Accepted and rejected decisions alone do not need a message: they reach the agent with the next one. With only the chat in view, or on a phone's **Chat** tab, the bar ends the conversation. The count is the number of review updates (a batch decision is one update). Updates also go with any message you type; pausing a queued message returns its updates to the unsent count. Deciding every change does not start the agent until you send feedback. When only the chat is visible, a card at the end of the conversation announces a new review round and opens it. In **Split** view, drag the divider between the PDF and the chat to resize the chat; with the divider focused, the arrow keys resize it and Enter or a double-click resets it. The width is saved in this browser. Rename a task from its **Task actions** menu or by double-clicking it in the sidebar; Enter saves and Escape cancels. Each Codex reply has a **Copy** button, and the browser tab shows the selected task and how many tasks are waiting for your reply.

The current review shows action bars and map markers only for pending changes. Accepted changes show the clean revised PDF; rejected changes show the clean original. Commented changes leave the pending list while their feedback waits to be sent. If one PDF region contains a mix of accepted and rejected edits, open **History** to inspect it; the viewer does not pretend the entire region was accepted. **History** shows the diffs and comments from any round. **Undo last decision** restores the most recent decision in the latest round, returning those changes to the current review. Earlier rounds are read-only. After sending feedback, the viewer shows the agent's progress; if the agent makes no new edits, the completed review stays clear of old Change bars.

**Bibliography changes** are reviewed entry by entry rather than as source lines. Each entry a change adds, modifies or removes in a `.bib` file appears whole under that change: every field with its value as written (a modified field shows its old and new value), the lines it occupies, and where the paper cites it. Hunks that touch the same entry make one change, so an entry is never half accepted; the raw source stays under **LaTeX**. Papilot then looks up each added or modified entry online: a DOI through doi.org, an arXiv identifier through arXiv, and otherwise the title and authors in Crossref, DBLP and arXiv. An entry is **Verified** when a record agrees in title, authors and year, **Differs from the record** when the same work has other details or its DOI names another work (the differing fields are listed against the record's, with a link to it), **Not verified** when no record matches, and **Could not check** when no source could be reached. Not verified is not proof that a work does not exist: theses, reports and many books are in none of these sources. A preprint's year before the published version's, or a subtitle, counts as a small difference only. A source that turns requests away, as DBLP's bot check sometimes does, is skipped, and the entry names it. The **Bibliography** line above the review counts the entries and lists those that need a look, together with removed entries the paper still cites, keys defined twice, entries in a `.bib` file the paper does not read, and new citations with no entry. Accepting (or staging) a change with such an entry asks first, and **Accept all** leaves those changes for you to decide one by one. An entry no source knows, such as a book or a thesis, can be marked **I checked it myself**: it then counts as checked in every later review, until its title, authors, year or identifiers change. Only an entry's title, authors, year and identifiers are sent; turn the lookups off with **Settings → Check references online**, which applies to this browser. Results are kept for a month, or a day when nothing matched, in the repository's `.git/latex-review/references.json`, and in the data folder for uncommitted changes. Agents are told never to write an entry from memory and to include its DOI or arXiv identifier.

**Reference check**, under **More** below **Manuscript** in the sidebar, checks the paper's whole bibliography as it is on disk: the `.bib` files named by `\bibliography` or `\addbibresource`, and the citations in every file the paper inputs. Without looking anything up it lists citations of keys no entry defines, keys defined twice, the same work under two keys (same DOI or title), entries the paper never cites (unless it uses `\nocite{*}`) and entries BibTeX cannot read. **Check online** compares each entry with Crossref, DBLP and arXiv as reviews do; results are kept, so later checks look up only new or edited entries, and **Check again** retries those that found nothing. **Problems** lists what needs a look, **All entries** every entry; open one to see all its fields, where it is cited, and the record it was compared with. **I checked it myself** works here as in reviews. **Ask an agent to look into** opens the manuscript's new task with the ticked problems in its prompt, which you can edit before sending. The agent is asked to change nothing and to find out what happened with each: whether the work exists and what its published record says, where the entry or citation came from in the Git history, and what it would suggest, marking which findings it confirmed in a source. What to change stays your decision. **More** opens its tools beside the sidebar (a sheet on a phone); once the check has run, the menu shows how many problems it found.

Conversation drafts are saved per task in this browser. Sending review comments preserves an unsent draft, and text entered while a message is sending stays in the composer. Switching tasks preserves pending submissions and unfinished Codex answers. If browser storage is unavailable, the workspace remains usable and drafts stay in the current tab until it closes or reloads. Press Enter to send and Shift+Enter for a new line. On touch keyboards, Enter adds a new line; use the send button. **Command+Enter** on macOS or **Ctrl+Enter** elsewhere always sends. Input-method composition is never sent by Enter. The new-task prompt is also saved in this browser until the task is created. Agent replies render Markdown, including tables, task lists, nested lists, fenced code and LaTeX mathematics (`$…$`, `$$…$$`, `\(…\)` and `\[…\]`, typeset with KaTeX, which loads the first time a reply contains mathematics). Your own messages show what you did: a skill as its name with your words, sent review feedback as its decisions and comments, and PDF notes as the notes, never the prompt the agent receives. Local file references copy their full path. The **Add a paper** and delete dialogs keep keyboard focus inside them; **Escape** closes them when no submission is in progress.

The mobile task drawer keeps keyboard focus inside it and closes with **Escape**, returning focus to its opener. Long conversations follow new messages until you scroll up; **Latest messages** returns to the bottom. Connection loss is shown above the workspace even when the sidebar is hidden. Failed conversation and PDF review loads offer their own retry controls, so your instruction draft stays in place.

To remove a task, open the **Task actions** menu (the ⋯ button that appears when you hover over or focus that task in the sidebar) and choose **Delete task**. Opening its menu does not change the task you are reading. The confirmation defaults to **Cancel** and explains the permanent removal of its Papilot conversation, worktree, PDF review files, and unaccepted edits and comments. Accepted manuscript changes and other tasks stay in place, but the deleted task's review decisions can no longer be undone. Pause active or queued work first using that task's menu, wait for PDF builds, and resolve uncertain actions before deleting. If cleanup is interrupted, the task stays reserved as **Deleting task**; use **Retry deletion** to confirm cleanup. The review engine owns the file removal. Codex host history and the engine's internal bookkeeping are managed separately.

Use **Full PDF** to open the entire manuscript from the selected review round, after the task’s changes. This is a complete build, even when the diff used a partial build. It includes pending changes from that round, so it is not the accepted main manuscript. The browser PDF viewer supports reading, zooming and downloading. The endpoint also accepts `version=before` and `download=1`.

Review acceptance updates the manuscript's working tree without committing. Git conflicts are surfaced by the review engine; they are not automatically overwritten. Accept, reject, and undo are disabled while the task is running, queued, building, or awaiting reconciliation, with a reason shown in the viewer. Pause the task or resolve that state before deciding its changes. You can still read and add comments while Codex works. Acceptance is a manuscript decision, distinct from a Codex command permission request.

If a Codex start request or a review write has an uncertain outcome, the task displays **Check status**. Further editing and manuscript decisions remain blocked until that action is reconciled. Checking a review write retries its original action ID, so it cannot apply a second decision or undo a different action. Pausing a queued message preserves feedback that has not yet reached Codex.

Messages and queued runs are saved in `papilot.sqlite` in the data folder. Closing the browser does not stop a run. After a process restart, confirmed in-flight turns are marked interrupted and can be continued; already queued follow-up messages are retained. Uncertain operations remain reserved until their outcome is checked. Reconnecting after an uncertain request does not promise exactly-once execution of arbitrary Codex commands.

Turn on **Settings → Notifications** for a browser notification when a task asks a question or for approval, its review is ready, or it stops with an error while Papilot is in another tab or app; clicking one opens the task. Browsers allow notifications only on HTTPS or localhost, so remotely use the Tailscale HTTPS address.

## Task attachments

Use **＋ → Add files…** in a new task or an existing conversation, drag files onto the composer, or paste an image from the clipboard. Uploaded files appear above the message, with image thumbnails and a remove action. A failed upload offers **Retry**; sending waits until every selected file has uploaded or been removed. Uploaded attachments stay with their paper or task when you navigate away or reload. Sending review feedback separately leaves your draft attachments in place.

Attach up to **10 files**, with **25 MB per file**, **5 MB per PNG, JPEG, GIF or WebP image**, and **100 MB total per message**. You can send attachments without text; the agent is then asked to identify the material and ask what you want to do, without editing the manuscript. Sent attachments remain available from the conversation.

Files are stored beside Papilot's database, outside the manuscript and task worktrees. Codex, Claude and Kimi receive supported raster images as native image inputs; other files are provided by their local paths for the agent to read with its tools. Antigravity receives image paths for its file/image tools rather than native image blocks. Reading a particular file format depends on the agent's tools; uploading does not automatically convert documents or import them into the paper. If you ask to use an attached figure or data file in the manuscript, the agent can copy it into its task worktree for review.

Draft uploads are private to their uploader. Sending them shares them with people who can access that paper; unsharing the paper also removes access to its attachments. Deleting a task removes its stored attachments after task cleanup is confirmed. Unsent uploads expire after 30 days and are cleaned up during later uploads; each person can keep up to 500 MB of unsent uploads per paper.

## Skills

A skill is a named set of instructions for a common revision, so you do not have to write the prompt each time. Type `/` at the start of the prompt for a new task or a follow-up, keep typing to narrow the list, and press Enter or Tab (or click) to choose one; Escape closes the list and Backspace in an empty prompt removes the chosen skill. You can also pick a skill from the composer's **+** menu. What you type next says where or how to apply it, such as "Section 3 only"; send without text to apply it to the whole paper. The agent receives the skill's instructions with your words, and the chat shows the skill's name.

The owner can open **Settings → Skills** to search, preview, create, edit and delete skills. New skills default to **Global** (`~/.papilot/skills/<id>/SKILL.md`); choose **This paper** to save in `<paper>/.papilot/skills/<id>/SKILL.md` instead. Global skills belong to the user and stay in the home folder even when `--data` or `PAPILOT_DATA` points the workspace database elsewhere. Saving updates the composer immediately. Built-in skills are read-only: use **Copy and edit** to customize one. The Markdown editor preserves front matter and supporting files. If a file changed elsewhere, reload it before saving. Deleting removes only the skill's Markdown file and leaves supporting files intact; a same-ID skill from a lower-priority scope becomes available again.

Papilot includes these skills:

| Skill | What it does |
| --- | --- |
| **Polish** | Improves clarity and flow sentence by sentence, keeping every claim, term and citation. |
| **Proofread** | Fixes typos, grammar and punctuation without rewording. |
| **Shorten** | Cuts length without losing results, definitions or citations; give a target such as "8 pages". |
| **Check math** | Checks notation, equations and proofs; fixes clear slips and reports suspected errors instead of changing results. |
| **Consistency** | Unifies terminology, spelling, notation, acronyms and reference style, using the paper's majority choice. |
| **Fix LaTeX warnings** | Builds the paper and fixes undefined references, overfull boxes and other warnings without silencing them globally. |
| **Address reviewers** | Revises for the reviewer comments you paste and ends with a point-by-point reply. |

Add your own as Markdown files: in `~/.papilot/skills/` for every paper, or in the paper's `.papilot/skills/` folder, committed with the paper, for that paper only. A paper's skill replaces one of yours with the same name, and yours replaces a built-in one. Each skill is `<name>.md` (lowercase letters, digits and hyphens), or a `<name>/SKILL.md` folder in the Agent Skills layout, whose other files the agent can read. Optional front matter gives its name, a one-line description, the hint shown in the empty prompt, and its order in the picker:

```markdown
---
name: Venue style
description: Follow the venue's style guide
hint: Which section?
order: 10
---
Follow the style guide in style.md: …
```

Papilot reads the skills again when you return to its window, so a new skill file appears without a restart.

## Remote access with Tailscale

Papilot binds **only to 127.0.0.1**. Configure a private Tailscale Serve endpoint and the exact owner login shown by your tailnet. The server verifies the remote Host, browser Origin, and Tailscale identity supplied by the local proxy.

```sh
export PAPILOT_PUBLIC_ORIGIN=https://your-host.your-tailnet.ts.net:8443
export PAPILOT_TAILSCALE_LOGIN=your-tailscale-login
papilot service install   # npm run service:install in a source checkout
tailscale serve --bg --https=8443 http://127.0.0.1:7274
```

This uses a separate HTTPS port so an existing service on 443 can stay in place. Keep devices connected to your tailnet. Never turn on Funnel for this endpoint: requests on it act as you, and Papilot refuses Funnel traffic there. To let people outside your tailnet in, see [Collaborators](#collaborators), which uses its own port. The Codex app-server itself is never exposed to the network.

If certificate issuance cannot reach Let's Encrypt, use a private HTTP endpoint over the encrypted tailnet instead:

```sh
export PAPILOT_PUBLIC_ORIGIN=http://your-host.your-tailnet.ts.net:8081
export PAPILOT_TAILSCALE_LOGIN=your-tailscale-login
papilot service install
tailscale serve --bg --http=8081 http://127.0.0.1:7274
```

With HTTP Serve, the connection is protected by Tailscale rather than browser HTTPS. Browser features that require a secure context, such as the viewer's clipboard button, may be unavailable; native text selection and copying remain available.

If you use a private Tailscale IP instead of a MagicDNS hostname, set `PAPILOT_PUBLIC_ORIGIN` to the exact URL you open in the browser and configure the matching Serve host. Keep the same origin and owner identity when reinstalling the service. Preserve any other Serve endpoints already running on the host.

The launchd user agent starts after login, restarts the service on exit, and uses `caffeinate -i` to prevent idle system sleep while Papilot runs. A full reboot still requires the account to log in. Run `papilot service stop` (`npm run service:stop` in a source checkout) to stop it. Logs are in `service.log` and `service.error.log` in the data folder.

The installer retains your shell's tool search path. To select a particular Python or TeX installation for the service, set `PAPILOT_SERVICE_PATH` to its absolute binary directory. Multiple directories use the usual path separator. This override is saved and reused when you reinstall the service. Set it to an empty string during installation to clear it.

For example, older `latexminted` releases can fail under Python 3.14 with `ArgParser.__init__() got an unexpected keyword argument 'color'` ([upstream issue](https://github.com/gpoore/minted/issues/463)). Update `latexminted`, or select an installed compatible Python. On a Mac with Homebrew Python 3.12 installed:

```sh
PAPILOT_SERVICE_PATH=/opt/homebrew/opt/python@3.12/libexec/bin papilot service install
```

Preserve your `PAPILOT_DATA`, port and remote-access settings when reinstalling. When a paper is accessed again, an existing review server with different tool paths is restarted after its active builds finish. Compilation errors show both the TeX diagnostic and Python helper exceptions when available. The saved build log includes the complete compiler output.

For SSH access without Tailscale, run `ssh -N -L 7274:127.0.0.1:7274 user@your-host` on the computer running your browser, keep that terminal open, and visit `http://localhost:7274`.

The workspace uses short, non-overlapping polling on HTTP/1 connections so multiple tabs cannot exhaust the browser's connection pool with permanent event streams. HTTP/2 and HTTP/3 connections use event streams. Hidden workspace tabs pause their status refreshes and update when reopened; task switches cancel obsolete conversation requests. If upgrading from an older frontend leaves pages loading indefinitely, close the old Papilot tabs and reopen the workspace.

## Collaborators

You can invite other people, such as an advisor or co-authors, to work on chosen papers. They sign in at a public HTTPS address with a passkey (Face ID, Touch ID, Windows Hello or a phone) and install nothing. Papilot never stores a password.

**Invite only people you would trust with access to the host.** In the papers you share, an invited person can do everything you can: start tasks, chat with agents, approve the commands agents ask to run on the host, accept or reject changes, add notes, and commit and push with the host's Git credentials. Papilot shows them only the papers you share. But agents, LaTeX builds (including a paper's `latexmkrc`) and approved commands run as you and can read any file on the host, including your other papers. So sharing limits what Papilot shows and allows, not what someone determined could reach.

The public address has its own local port, separate from your tailnet endpoint. With Tailscale Funnel, which allows only ports 443, 8443 and 10000, use 10000 so it leaves your Serve endpoint on 8443 alone:

```sh
export PAPILOT_ACCOUNT_ORIGIN=https://your-host.your-tailnet.ts.net:10000
papilot service install
tailscale funnel --bg --https=10000 http://127.0.0.1:7275
```

A reverse proxy works too: forward the HTTPS origin to `127.0.0.1:7275` (`PAPILOT_ACCOUNT_PORT`). Papilot refuses to start if the account address equals `PAPILOT_PUBLIC_ORIGIN`, if both use the same port, or if it is not HTTPS (plain `http://localhost` is allowed for testing). Every request on the account port is treated as coming from the internet: it needs a signed-in session, POST requests need a matching `Origin`, and Tailscale identity headers are ignored there.

Open **People** in the sidebar to manage access:

- **Invite someone** takes their name and the papers they can open, and gives you a link to send them yourself. It works once, within 7 days. Opening it asks them to create a passkey, after which they are signed in. The link's secret is in the part after `#`, which browsers never send to a server.
- Tick or untick a person's papers at any time. The change applies to their next request, and their open tabs update at once.
- **Invite link for a new device** adds a passkey on another device, or replaces a lost one.
- Each passkey and signed-in browser is listed and can be removed on its own. **Sign out everywhere** ends all of a person's sessions, and **Remove…** deletes the person, their passkeys and their sessions.
- **Sign in from anywhere** gives you a link (valid for 15 minutes) to create your own passkey, so you can use the public address too. There you are the owner, as on the host itself.

Sessions last 30 days from last use and at most 90 days. Invited people cannot add papers or manage people; those stay with you. Their messages and PDF notes show their name. Review comments and Git commits do not record who made them yet. Passkeys belong to the address's host name, so renaming the host or the tailnet means everyone needs a new invite.

## Updates

The owner sees a **New version** badge beside **Settings** when npm has a newer stable Papilot release. Papilot checks at startup and every six hours. Click the badge, then **Update to …**; the panel shows installation, waiting, restart and failure states. Collaborators cannot update the host.

Open **Settings → Updates** to check manually or choose an update channel. **Stable** uses npm releases. **Dev (GitHub main)** checks the latest commit on `PapilotAI/papilot`'s `main` branch; the version includes its short commit ID. Choosing a channel checks availability without installing anything. Click **Update to …** to download and build that exact commit in a separate managed directory. Dev builds require Git, npm and at least 2 GB of free disk space. They may be less reliable; select **Stable** and install its latest release to return. Both channels keep the existing data directory, wait for active work to finish, and restore the previous installation if startup fails.

The installer downloads the exact advertised version into `PAPILOT_DATA/updates/releases`, installs its dependencies and tests startup with a separate empty data directory. It does not overwrite the original npm installation, source checkout, manuscripts or worktrees. npm must be available to the server. The update waits for active tasks, pending replies, uncertain tasks, PDF builds and outstanding requests before restarting; finish or pause those tasks to proceed. The page reconnects and reloads automatically with its saved drafts.

The `papilot` command, `npm start` and the installed macOS service use the selected release on subsequent starts. Starting from a source checkout after a browser update also uses that selected release with the same data directory; use a separate `PAPILOT_DATA` for development. Newer versions installed through npm take precedence over older managed releases. Automatic restarts support the standalone server and the built-in macOS service.

If installation or its initial startup check fails, the existing server keeps running. If activation fails, Papilot restores the previous runtime and its pre-update SQLite database, including any WAL, and restarts it. The badge offers **Retry update**. Installation and restart diagnostics are in `PAPILOT_DATA/updates/install.log` and `restart.log`; the standalone restarted server writes to `updates/server.log`.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PAPILOT_PORT` | `7274` | Local HTTP port; the server binds to `127.0.0.1`. |
| `PAPILOT_DATA` | `~/.papilot` for the `papilot` command, `.papilot` in a source checkout | SQLite state and generated example project. |
| `PAPILOT_CODEX_BIN` | `codex` on `PATH` (0.164.0 or newer), else one installed into the data folder | Codex executable used by the backend. |
| `PAPILOT_SERVICE_PATH` | Unset | Absolute tool directories to prioritize in the macOS service; retained across service reinstalls. |
| `PAPILOT_CLAUDE_BIN` | `claude` on `PATH` | Claude Code CLI used for Claude tasks; when found, Claude runs `claude -p` on its login instead of the Agent SDK. |
| `ANTHROPIC_API_KEY` | Unset | Anthropic API key for Claude tasks (the Agent SDK does not accept a Claude subscription login). |
| `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` | Unset | Run Claude tasks on a gateway or another service's Anthropic-compatible endpoint, with that service's key. `ANTHROPIC_DEFAULT_OPUS_MODEL` and its Sonnet, Fable and Haiku counterparts map the model menu onto its models. |
| `CURSOR_API_KEY` | Unset | Cursor API key for Cursor tasks (the Cursor SDK does not use the app or CLI login). |
| `ZHIPU_API_KEY`, `ZAI_API_KEY` | Unset | GLM Coding Plan or API key for GLM tasks, on open.bigmodel.cn or api.z.ai respectively. |
| `PAPILOT_KIMI_BIN` | `kimi` on `PATH` | Kimi Code CLI used for Kimi tasks; use an absolute path for background services if needed. |
| `PAPILOT_DSH_BIN` | `dsh` on `PATH` | DeepSeek Harness CLI used for DeepSeek tasks. |
| `PAPILOT_QWEN_BIN` | `qwen` on `PATH` | Qwen Code CLI used for Qwen tasks. |
| `PAPILOT_OPENCODE_BIN` | `opencode` on `PATH` | OpenCode CLI used for OpenCode tasks. |
| `PAPILOT_AGY_BIN` | `agy` on `PATH` | Antigravity CLI used for Antigravity tasks. |
| `PAPILOT_AGY_PROXY` | Unset | HTTP proxy for agy only, for regions where Antigravity needs one. |
| `PAPILOT_REVIEW_ENGINE` | `vendor/latex-review` | Review engine directory. |
| `PAPILOT_PUBLIC_ORIGIN` | Unset | Exact remote browser origin, including scheme and port. |
| `PAPILOT_TAILSCALE_LOGIN` | Unset | Tailscale login allowed to access the remote workspace. |
| `PAPILOT_ACCOUNT_ORIGIN` | Unset | Public HTTPS origin where [collaborators](#collaborators) sign in with passkeys, such as a Funnel address on port 10000. Unset, there is no public sign-in. |
| `PAPILOT_ACCOUNT_PORT` | `7275` | Local port the public address is forwarded to; the server binds it to `127.0.0.1`. |

## Development and validation

```sh
npm run typecheck
npm test
npm run build
npm run test:ui
```

The landing page at [papilot.ai](https://papilot.ai/) lives in `site/`. It is bilingual: text appears in `lang="en"` and `lang="zh-CN"` spans, and attributes carry their Chinese in `data-zh-*`, so change both when editing. `npm run site` renders the shared examples in `site/demo-templates.mjs` into `_site/index.html`, copies the styles, small animation script and workspace fonts, and checks local asset references. Serve `_site` through any static server to preview it. `npm run test:site` builds and checks these demos in an isolated browser (using the same Playwright/Chrome setup as `test:ui`) and saves desktop/mobile screenshots in `test-results/site`.

The hero and four feature examples use HTML, CSS and native MathML. They recreate a full 1000 × 740 desktop workspace with the product's 46px toolbar and 340px side panel, then scale the entire composition uniformly to fit the page, including on phones. `site/demos.js` automatically loops through selection, writing a note, reviewing and accepting a change, navigating the paper, and committing a source file. The examples have no interactive controls or inner scrolling. Animation pauses offscreen and in background tabs; reduced-motion preferences remove typing and movement while retaining automatic scene changes. Without JavaScript, each example remains a static view. These examples never contact an agent or write to Git. The README's images and social preview remain separate assets. The Pages workflow publishes the site when its sources change on `main`.

`npm run dev` watches the TypeScript backend. After frontend changes, run `npm run build` and reload the browser; the server serves rebuilt assets without a restart. Backend changes require a restart, which interrupts active turns, so wait for running tasks to finish first. To develop alongside an existing instance, use a different `PAPILOT_PORT` and `PAPILOT_DATA` directory.

The automated tests cover restart recovery, access restrictions, review proxy routes, Codex RPC, worktree reservations, stale events, uncertain-operation recovery, rebuilt frontend assets, and draft preservation during feedback, retries, and concurrent editing.

`npm run test:ui` uses Playwright from the review engine's development dependencies (installed by `npm run setup:review`) and an installed Chrome browser. Set `PAPILOT_BROWSER_CHANNEL` to use another installed Playwright browser channel. It exercises English copy, keyboard focus, mobile layouts, the PDF viewer (contents, paging, zoom, search, text and region notes) against `tests/fixtures/outline.pdf`, request failures, navigation during submission, stale snapshots, unanswered Codex requests, blocked browser storage, connection recovery, long conversations, and task deletion confirmation and retries. `scripts/check-accounts.mjs` starts a real server with a public address on `localhost` and two disposable papers: the owner invites someone, who joins with a passkey from Chrome's virtual authenticator, sees only the shared paper, signs out and in, and is signed out when unshared and removed. It saves screenshots in `test-results`. Browser checks use an isolated local server and simulated task data; they do not start real Codex runs or modify manuscripts. Backend deletion tests also exercise the actual review engine against a disposable Git repository, checking that accepted manuscript content and another task's worktree survive cleanup.

Codex recovery uses the bundled CLI's generated protocol definitions and the [official app-server protocol](https://developers.openai.com/codex/app-server). It matches the pending message identity before adopting a turn and never treats a transport timeout as proof that a turn stopped.

The app reuses the existing review viewer, including its lazy images and immutable assets. Full section-level JSON pagination and text-layer virtualization remain future work.

`scripts/verify-demo.ts --allow-example-writes` is an opt-in integration check for the generated sample only. After two real Codex tasks and a reviewer-requested second round, it checks conflict rejection, accepted changes from independent worktrees, undo, and proxied SVG delivery. Its safety check requires the exact `.papilot/example-paper` project and the recorded smoke-test task IDs; it will not run against an arbitrary manuscript.

To release, set the version in `package.json` and `package-lock.json`, give it a `## [x.y.z] - date` section in `CHANGELOG.md`, commit, and push a `vx.y.z` tag. Optionally append ` — Release title` to that heading to name the GitHub release `Papilot x.y.z — Release title`. The **Release** workflow checks that the tag, `package.json` and the CHANGELOG agree, runs the type check and tests, publishes to npm and creates the GitHub release from that CHANGELOG section. npm accepts the workflow through [trusted publishing](https://docs.npmjs.com/trusted-publishers), so publishing needs no token or one-time code. Rerunning a failed release skips the steps that already succeeded.

## Review engine

`vendor/latex-review` is based on the existing MIT-licensed `latex-review-skill`. Its upstream revision is recorded in `UPSTREAM_COMMIT`; its license and source are preserved. A small viewer integration honors Papilot's decision availability state. Papilot's copy also compares the whole PDFs to list the places an edit changes away from its own lines, as its reference describes. It also reads `.bib` changes entry by entry and checks added and modified entries online (`src/core/bib.ts`, `src/core/verify.ts`, and `GET /api/tasks/:name/rounds/:number/references`). Papilot uses the engine's public HTTP interface and does not write its SQLite database. The embedded review gateway only exposes review assets and review decisions, not shutdown or task-deletion endpoints.

See [REQUIREMENTS.md](../REQUIREMENTS.md) for the initial scope and acceptance criteria.
