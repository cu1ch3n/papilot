import fs from "node:fs";
import path from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import Fastify from "fastify";
import staticFiles from "@fastify/static";
import compress from "@fastify/compress";
import { WEB, codeVersion, environmentVersion } from "./runtime.ts";
import { Repo } from "./core/git.ts";
import { CONFIG_NAME, loadProject, type Project } from "./core/config.ts";
import { Store } from "./core/store.ts";
import { Tasks } from "./core/tasks.ts";
import { Review } from "./core/review.ts";
import { Deliveries } from "./core/delivery.ts";
import { more, PublishError, Publisher } from "./core/publish.ts";
import { acquireLock, now, readJson, writeJson } from "./core/files.ts";
import { stopAll } from "./core/process.ts";
import { checkInputs, Confirmations, ReferenceChecker } from "./core/verify.ts";
import type { ActionKind } from "./types.ts";
export class App {
  root: string;
  repo: Repo;
  state: string;
  store: Store;
  csrf = randomBytes(32).toString("base64url");
  viewers = new Map<string, number>();
  url = "";
  activity = now();
  tasks: Tasks;
  review: Review;
  delivery: Deliveries;
  publisher: Publisher;
  references: ReferenceChecker;
  confirmations: Confirmations;
  private cachedProject?: Project;
  private stamp?: number;
  constructor(root: string) {
    this.root = fs.realpathSync(root);
    this.repo = new Repo(this.root);
    this.state = path.join(this.repo.gitDir(), "latex-review");
    this.store = new Store(path.join(this.state, "state.sqlite3"));
    this.tasks = new Tasks(this);
    this.review = new Review(this);
    this.delivery = new Deliveries(this);
    this.publisher = new Publisher(this);
    this.references = new ReferenceChecker(
      path.join(this.state, "references.json"),
    );
    this.confirmations = new Confirmations(
      path.join(this.state, "references-confirmed.json"),
    );
    this.review.recover();
    this.delivery.recover();
  }
  get project() {
    const config = path.join(this.root, CONFIG_NAME),
      stamp = fs.existsSync(config) ? fs.statSync(config).mtimeMs : 0;
    if (!this.cachedProject || this.stamp !== stamp) {
      this.cachedProject = loadProject(this.root);
      this.stamp = stamp;
    }
    return this.cachedProject;
  }
  page(name: string) {
    return `${this.url}/?task=${encodeURIComponent(name)}`;
  }
  taskInfo(name: string) {
    const task = this.tasks.get(name),
      delivery = this.delivery.get(name),
      scope = task.scope;
    return {
      ...this.review.summary(name),
      deferred: Boolean(task.deferred),
      delivery: delivery ? { ...this.delivery.result(delivery), pending: !delivery.done } : null,
      worktree: task.worktree,
      url: this.page(name),
      viewing: now() - (this.viewers.get(name) ?? 0) < 15,
      scope: {
        sections: scope.sections.map((s) => `${s.number} ${s.title}`.trim()),
        files: scope.ranges
          ? Object.entries(scope.ranges).flatMap(([file, spans]) =>
              spans.map(([a, b]) => `${file}:${a}-${b}`),
            )
          : scope.paths,
      },
    };
  }
  tasksOverview() {
    return this.tasks.list().map((task) => {
      const { next: _next, ...summary } = this.review.summary(task.name);
      return { ...summary, url: this.page(task.name) };
    });
  }
  async close() {
    this.publisher.stop();
    await this.publisher.join();
    this.store.close();
  }
}
export function createServer(app: App) {
  const server = Fastify({ logger: false, bodyLimit: 999999 });
  server.register(compress, { threshold: 1024 });
  server.addHook("onRequest", async (request, reply) => {
    app.activity = now();
    const port = new URL(app.url || "http://127.0.0.1:80").port || "80",
      hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    reply
      .header("Cache-Control", "no-store")
      .header("X-Content-Type-Options", "nosniff")
      .header("X-Frame-Options", "DENY");
    if (
      !hosts.has(request.headers.host ?? "") ||
      (request.headers.origin &&
        ![...hosts].some((h) => request.headers.origin === "http://" + h))
    )
      return reply
        .code(403)
        .send({ error: "Only same-origin localhost requests are accepted." });
    if (request.method === "POST") {
      const token = Buffer.from(
          String(request.headers["x-review-token"] ?? ""),
        ),
        expected = Buffer.from(app.csrf);
      if (token.length !== expected.length || !timingSafeEqual(token, expected))
        return reply
          .code(403)
          .send({ error: "This page is out of date. Reload it." });
    }
  });
  server.setErrorHandler((error, _request, reply) => {
    const e = error as Error & { statusCode?: number };
    reply.code(e.statusCode ?? 400).send({ error: e.message });
  });
  server.after(() => {
    server.get("/api/info", () => ({
      root: app.root,
      version: codeVersion(),
      environment: environmentVersion(),
      pid: process.pid,
      busy: app.publisher.busy(),
      build_workers: app.project.build_workers,
      csrf: app.csrf,
      runtime: "typescript",
    }));
    server.get("/api/tasks", () => ({
      tasks: app.tasksOverview(),
      csrf: app.csrf,
    }));
    server.get<{ Params: { id: string } }>("/api/jobs/:id", (request) => {
      const j = app.publisher.job(request.params.id);
      return {
        id: j.id,
        task: j.task,
        status: j.status,
        phase: j.phase,
        ...j.result,
      };
    });
    server.get<{ Params: { name: string } }>("/api/tasks/:name", (request) =>
      app.taskInfo(request.params.name),
    );
    server.get<{ Params: { name: string }; Querystring: { round?: string } }>(
      "/api/tasks/:name/state",
      (request) =>
        app.review.pageState(
          request.params.name,
          request.query.round && /^\d+$/.test(request.query.round)
            ? Number(request.query.round)
            : undefined,
        ),
    );
    server.get<{ Params: { name: string }; Querystring: { after?: string } }>(
      "/api/tasks/:name/feedback",
      (request) =>
        app.review.feedback(
          request.params.name,
          /^\d+$/.test(request.query.after ?? "")
            ? Number(request.query.after)
            : 0,
        ),
    );
    server.get<{ Params: { name: string; number: string } }>(
      "/api/tasks/:name/rounds/:number",
      (request) =>
        app.review.roundDetail(
          request.params.name,
          Number(request.params.number),
        ),
    );
    // The places an edit changes away from its lines, past those its round
    // rendered: rendering them takes a moment, so the page asks for them.
    server.get<{ Params: { name: string; number: string; unit: string } }>(
      "/api/tasks/:name/rounds/:number/effects/:unit",
      async (request, reply) => {
        const { name, number, unit } = request.params;
        if (!/^\d+$/.test(number) || !/^c\d+$/.test(unit))
          return reply.code(404).send({ error: "No such change" });
        try {
          app.review.round(name, Number(number));
        } catch {
          return reply.code(404).send({ error: "No such round" });
        }
        try {
          return {
            places: await more(
              path.join(
                app.state,
                "rounds",
                name,
                String(Number(number)).padStart(3, "0"),
              ),
              unit,
            ),
          };
        } catch (error) {
          if (!(error instanceof PublishError)) throw error;
          return reply
            .code(409)
            .send({ error: `${error.message} ${error.next}`.trim() });
        }
      },
    );
    // Checks of the bibliography entries a round adds or modifies. The page
    // asks with check=1 to look up entries online, and keeps asking until
    // none is pending; without it only results already known are returned.
    server.get<{
      Params: { name: string; number: string };
      Querystring: { check?: string; retry?: string };
    }>("/api/tasks/:name/rounds/:number/references", (request) => {
      const inputs = checkInputs(
        app.review.roundDetail(request.params.name, Number(request.params.number))
          .references,
      );
      return {
        ...app.references.lookup(
          inputs,
          request.query.check === "1",
          request.query.retry === "1",
        ),
        confirmed: app.confirmations.of(inputs),
      };
    });
    // The author confirms, or takes back, that they checked an entry by hand.
    server.post<{
      Params: { name: string; number: string };
      Body: { id: string; confirmed: boolean };
    }>(
      "/api/tasks/:name/rounds/:number/references/confirm",
      {
        schema: {
          body: {
            ...{ type: "object" as const },
            required: ["id", "confirmed"],
            properties: { id: { type: "string" }, confirmed: { type: "boolean" } },
          },
        },
      },
      (request, reply) => {
        const inputs = checkInputs(
            app.review.roundDetail(request.params.name, Number(request.params.number))
              .references,
          ),
          input = inputs.find((i) => i.id === request.body.id);
        if (!input) return reply.code(404).send({ error: "No such entry in this round." });
        app.confirmations.set(input, request.body.confirmed);
        return {
          ...app.references.lookup(inputs),
          confirmed: app.confirmations.of(inputs),
        };
      },
    );
    server.get<{ Params: { name: string; number: string; file: string } }>(
      "/files/:name/:number/:file",
      (request, reply) => {
        const { name, number, file } = request.params;
        app.tasks.get(name, false);
        if (!/^\d+$/.test(number) || !/^[\w.-]+\.(svg|png)$/.test(file))
          return reply.code(404).send({ error: "No such file" });
        const target = path.join(
          app.state,
          "rounds",
          name,
          String(Number(number)).padStart(3, "0"),
          file,
        );
        if (!fs.existsSync(target))
          return reply.code(404).send({ error: "No such file" });
        reply
          .header("Cache-Control", "private, max-age=31536000, immutable")
          .type(file.endsWith(".svg") ? "image/svg+xml" : "image/png");
        return fs.createReadStream(target);
      },
    );
    const objectSchema = { type: "object" as const };
    server.post<{
      Body: {
        name?: string;
        title?: string;
        sections?: string[];
        files?: string[];
        deferred?: boolean;
      };
    }>(
      "/api/tasks",
      {
        schema: {
          body: {
            ...objectSchema,
            properties: {
              name: { type: "string" },
              title: { type: "string" },
              sections: { type: "array", items: { type: "string" } },
              files: { type: "array", items: { type: "string" } },
              deferred: { type: "boolean" },
            },
          },
        },
      },
      (request) => {
        const d = request.body;
        return app.taskInfo(
          app.tasks.create(d.name, d.title, d.sections, d.files, d.deferred).name,
        );
      },
    );
    server.post<{ Params: { name: string } }>(
      "/api/tasks/:name/publish",
      (request) => {
        app.delivery.assertReady(request.params.name);
        const job = app.publisher.submit(request.params.name);
        return { job: job.id, status: job.status };
      },
    );
    server.post<{ Params: { name: string }; Body: { mode: "workspace" | "branch"; message?: string } }>(
      "/api/tasks/:name/deliver",
      { schema: { body: { ...objectSchema, required: ["mode"], properties: { mode: { enum: ["workspace", "branch"] }, message: { type: "string", maxLength: 5000 } } } } },
      request => app.delivery.deliver(request.params.name, request.body.mode, request.body.message),
    );
    server.post<{
      Params: { name: string };
      Body: {
        action: ActionKind;
        id?: string;
        changes: string[];
        round: number;
        body?: string;
      };
    }>(
      "/api/tasks/:name/decide",
      {
        schema: {
          body: {
            ...objectSchema,
            required: ["action", "changes", "round"],
            properties: {
              action: { enum: ["accept", "reject", "comment"] },
              id: { type: "string" },
              changes: { type: "array", items: { type: "string" } },
              round: { type: "integer", minimum: 1 },
              body: { type: "string" },
            },
          },
        },
      },
      (request) => app.review.decide(request.params.name, request.body),
    );
    server.post<{ Params: { name: string }; Body: { id: string } }>(
      "/api/tasks/:name/undo",
      {
        schema: {
          body: {
            ...objectSchema,
            required: ["id"],
            properties: { id: { type: "string" } },
          },
        },
      },
      (request) => app.review.undo(request.params.name, request.body.id),
    );
    server.post<{ Params: { name: string }; Body: { body: string } }>(
      "/api/tasks/:name/note",
      {
        schema: {
          body: {
            ...objectSchema,
            required: ["body"],
            properties: { body: { type: "string" } },
          },
        },
      },
      (request) => app.review.note(request.params.name, request.body.body),
    );
    server.post<{ Params: { name: string }; Body: { force?: boolean } }>(
      "/api/tasks/:name/finish",
      {
        schema: {
          body: { ...objectSchema, properties: { force: { type: "boolean" } } },
        },
      },
      async (request) => {
        const result = await app.tasks.finish(
          request.params.name,
          request.body.force,
        );
        return {
          task: request.params.name,
          finished: true,
          changed_files: result.changed,
          discarded: Object.fromEntries(
            Object.entries(result.discarded).filter(
              ([k, n]) => ["pending", "commented"].includes(k) && n,
            ),
          ),
        };
      },
    );
    server.post<{ Body: { force?: boolean } }>(
      "/api/shutdown",
      {
        schema: {
          body: { ...objectSchema, properties: { force: { type: "boolean" } } },
        },
      },
      (request, reply) => {
        if (app.publisher.busy() && !request.body.force)
          throw new Error(
            "A round is being built. Stop after it finishes, or force the stop.",
          );
        reply.send({ ok: true });
        setImmediate(() => {
          app.publisher.stop();
          stopAll();
          void server.close();
        });
      },
    );
    if (fs.existsSync(WEB)) {
      server.register(staticFiles, {
        root: WEB,
        prefix: "/",
        cacheControl: false,
        setHeaders: (response) => response.header("Cache-Control", "no-cache"),
      });
    } else
      server.get("/", (_req, reply) =>
        reply
          .type("text/plain")
          .send("Build the review UI with npm run build."),
      );
  });
  return server;
}
export async function serve(root: string, port = 0, idle = 12 * 3600) {
  root = new Repo(root).toplevel();
  process.chdir(root);
  const home = path.join(new Repo(root).gitDir(), "latex-review/server"),
    release = await acquireLock(path.join(home, "server.lock"), false),
    app = new App(root),
    server = createServer(app);
  let timer: NodeJS.Timeout | undefined;
  try {
    try {
      await server.listen({ host: "127.0.0.1", port });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      await server.listen({ host: "127.0.0.1", port: 0 });
    }
    const address = server.server.address();
    if (!address || typeof address === "string")
      throw new Error("No server address");
    app.url = `http://127.0.0.1:${address.port}`;
    const info = {
      url: app.url,
      port: address.port,
      pid: process.pid,
      version: codeVersion(),
      root,
      runtime: "typescript",
    };
    writeJson(path.join(home, "connection.json"), info, 0o600);
    writeJson(path.join(home, "last.json"), { port: address.port });
    const shutdown = () => {
      app.publisher.stop();
      stopAll();
      void server.close();
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
    timer = setInterval(
      () => {
        if (now() - app.activity > idle && !app.publisher.busy()) shutdown();
      },
      Math.min(30000, idle * 1000),
    );
    console.log(JSON.stringify(info));
    await new Promise<void>((resolve) => server.server.once("close", resolve));
  } finally {
    if (timer) clearInterval(timer);
    app.publisher.stop();
    stopAll();
    await app.close();
    if (
      readJson<{ pid?: number }>(path.join(home, "connection.json"), {}).pid ===
      process.pid
    )
      fs.rmSync(path.join(home, "connection.json"), { force: true });
    await release();
  }
}
