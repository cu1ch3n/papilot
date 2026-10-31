---
name: Fix LaTeX warnings
description: Resolve undefined references, overfull boxes and other build warnings
hint: Anything to leave alone? Leave empty to fix every warning you can
order: 6
---
Fix the problems LaTeX reports when it builds the paper.

- When the request lists problems from the last compilation, with their files and lines, fix those. Otherwise compile in your worktree (for example with `latexmk`) and read the log. If you cannot run commands, look for the same problems in the source instead.
- Fix undefined or duplicate labels, references and citations; overfull boxes, by rewording slightly or allowing a break where the line overflows; and package warnings that point to real mistakes.
- Do not silence warnings globally: no document-wide `\sloppy`, badness or tolerance changes, and no new packages, unless the request asks for them.
- In your summary, list the warnings you fixed and any you left, with the reason.
