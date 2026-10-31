import fs from "node:fs";
import path from "node:path";
import { it, expect } from "vitest";
import { which } from "../../src/core/process.ts";
import { view } from "../../src/core/view.ts";
import { Fixture, METHOD } from "./helpers.ts";
const tex = Boolean(which("latexmk") && which("pdflatex") && which("synctex"));
const png = (page: { file: string }) =>
  fs.readFileSync(page.file).subarray(1, 4).toString();
it.skipIf(!tex)(
  "draws the pages where source lines and printed page numbers are typeset",
  async () => {
    const f = new Fixture(),
      app = f.app();
    try {
      const task = app.tasks.create("look");
      f.edit(task, METHOD, "Method sentence 3.", "Method sentence three, revised.");
      const shown = await view(app, task.name, {
        locations: [`${METHOD}:6`, path.join(task.worktree, METHOD) + ":7"],
        pages: ["1", "99"],
      });
      expect(shown.error).toBeUndefined();
      expect(shown.pages).toHaveLength(1);
      expect(shown.pages[0]).toMatchObject({ index: 1, label: "1" });
      expect(shown.pages[0].shows).toEqual([`${METHOD}:6`, path.join(task.worktree, METHOD) + ":7", "1"]);
      expect(png(shown.pages[0])).toBe("PNG");
      expect(path.basename(shown.pages[0].file)).toBe("page-1-1.png");
      expect(shown.pages[0].file.startsWith(path.join(app.project.state, "views", task.name))).toBe(true);
      expect(shown.missing).toEqual(["Page 99: no page has this printed number."]);
      // The accepted text can be seen too.
      const accepted = await view(app, task.name, { pages: ["1"], accepted: true });
      expect(accepted.pages.map((p) => p.label)).toEqual(["1"]);
      await expect(view(app, task.name, { locations: ["../outside.tex:1"] })).rejects.toThrow(
        /repository-relative path/,
      );
      await expect(view(app, task.name, {})).rejects.toThrow(/at least one/);
    } finally {
      await f.close();
    }
  },
);
it.skipIf(!tex)("reports a worktree that does not compile", async () => {
  const f = new Fixture(),
    app = f.app();
  try {
    const task = app.tasks.create("broken");
    fs.appendFileSync(path.join(task.worktree, METHOD), "\\undefinedcommand\n");
    const shown = await view(app, task.name, { locations: [`${METHOD}:3`] });
    expect(shown.pages).toEqual([]);
    expect(shown.error).toBe("The paper in the task worktree could not be compiled.");
    expect(shown.details!.join("\n")).toMatch(/Undefined control sequence/);
  } finally {
    await f.close();
  }
});
