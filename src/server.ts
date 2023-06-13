import { assertConfigIsValid, config } from "./config";
import "source-map-support/register";
import express from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import childProcess from "child_process";
import { logger } from "./logger";
import { keyPool } from "./key-management";
import { adminRouter } from "./admin/routes";
import { proxyRouter } from "./proxy/routes";
import { handleInfoPage } from "./info-page";
import { logQueue } from "./prompt-logging";
import { start as startRequestQueue } from "./proxy/queue";
import { init as initUserStore } from "./proxy/auth/user-store";
import { checkOrigin } from "./proxy/check-origin";

const PORT = config.port;

const app = express();
// middleware
app.use(
  pinoHttp({
    quietReqLogger: true,
    logger,
    autoLogging: {
      ignore: (req) => {
        const ignored = ["/proxy/kobold/api/v1/model", "/health"];
        return ignored.includes(req.url as string);
      },
    },
    redact: {
      paths: [
        "req.headers.cookie",
        'res.headers["set-cookie"]',
        "req.headers.authorization",
        'req.headers["x-api-key"]',
        'req.headers["x-forwarded-for"]',
        'req.headers["x-real-ip"]',
        'req.headers["true-client-ip"]',
        'req.headers["cf-connecting-ip"]',
        // Don't log the prompt text on transform errors
        "body.messages",
        "body.prompt",
      ],
      censor: "********",
    },
  })
);

app.get("/health", (_req, res) => res.sendStatus(200));
app.use((req, _res, next) => {
  req.startTime = Date.now();
  req.retryCount = 0;
  next();
});
app.use(cors());
app.use(
  express.json({ limit: "10mb" }),
  express.urlencoded({ extended: true, limit: "10mb" })
);

// TODO: Detect (or support manual configuration of) whether the app is behind
// a load balancer/reverse proxy, which is necessary to determine request IP
// addresses correctly.
app.set("trust proxy", true);

// routes
app.use(checkOrigin);
app.get("/", handleInfoPage);
app.use("/admin", adminRouter);
app.use("/proxy", proxyRouter);

// 500 and 404
app.use((err: any, _req: unknown, res: express.Response, _next: unknown) => {
  if (err.status) {
    res.status(err.status).json({ error: err.message });
  } else {
    logger.error(err);
    res.status(500).json({
      error: {
        type: "proxy_error",
        message: err.message,
        stack: err.stack,
        proxy_note: `Reverse proxy encountered an internal server error.`,
      },
    });
  }
});
app.use((_req: unknown, res: express.Response) => {
  res.status(404).json({ error: "Not found" });
});

async function start() {
  logger.info("Server starting up...");
  await setBuildInfo();

  logger.info("Checking configs and external dependencies...");
  await assertConfigIsValid();

  keyPool.init();

  if (config.gatekeeper === "user_token") {
    await initUserStore();
  }

  if (config.promptLogging) {
    logger.info("Starting prompt logging...");
    logQueue.start();
  }

  if (config.queueMode !== "none") {
    logger.info("Starting request queue...");
    startRequestQueue();
  }

  app.listen(PORT, async () => {
    logger.info({ port: PORT }, "Now listening for connections.");
    registerUncaughtExceptionHandler();
  });

  logger.info(
    { build: process.env.BUILD_INFO, nodeEnv: process.env.NODE_ENV },
    "Startup complete."
  );
}

function registerUncaughtExceptionHandler() {
  process.on("uncaughtException", (err: any) => {
    logger.error(
      { err, stack: err?.stack },
      "UNCAUGHT EXCEPTION. Please report this error trace."
    );
  });
  process.on("unhandledRejection", (err: any) => {
    logger.error(
      { err, stack: err?.stack },
      "UNCAUGHT PROMISE REJECTION. Please report this error trace."
    );
  });
}

/**
 * Attepts to collect information about the current build from either the
 * environment or the git repo used to build the image (only works if not
 * .dockerignore'd). If you're running a sekrit club fork, you can no-op this
 * function and set the BUILD_INFO env var manually, though I would prefer you
 * didn't set it to something misleading.
 */
async function setBuildInfo() {
  // Render .dockerignore's the .git directory but provides info in the env
  if (process.env.RENDER) {
    const sha = process.env.RENDER_GIT_COMMIT?.slice(0, 7) || "unknown SHA";
    const branch = process.env.RENDER_GIT_BRANCH || "unknown branch";
    const repo = process.env.RENDER_GIT_REPO_SLUG || "unknown repo";
    const buildInfo = `${sha} (${branch}@${repo})`;
    process.env.BUILD_INFO = buildInfo;
    logger.info({ build: buildInfo }, "Got build info from Render config.");
    return;
  }

  try {
    // Ignore git's complaints about dubious directory ownership on Huggingface
    // (which evidently runs dockerized Spaces on Windows with weird NTFS perms)
    if (process.env.SPACE_ID) {
      childProcess.execSync("git config --global --add safe.directory /app");
    }

    const promisifyExec = (cmd: string) =>
      new Promise((resolve, reject) => {
        childProcess.exec(cmd, (err, stdout) =>
          err ? reject(err) : resolve(stdout)
        );
      });

    const promises = [
      promisifyExec("git rev-parse --short HEAD"),
      promisifyExec("git rev-parse --abbrev-ref HEAD"),
      promisifyExec("git config --get remote.origin.url"),
      promisifyExec("git status --porcelain"),
    ].map((p) => p.then((result: any) => result.toString().trim()));

    let [sha, branch, remote, status] = await Promise.all(promises);

    remote = remote.match(/.*[\/:]([\w-]+)\/([\w\-\.]+?)(?:\.git)?$/) || [];
    const repo = remote.slice(-2).join("/");
    status = status
      // ignore Dockerfile changes since that's how the user deploys the app
      .split("\n")
      .filter((line: string) => !line.endsWith("Dockerfile") && line);

    const changes = status.length > 0;

    const build = `${sha}${changes ? " (modified)" : ""} (${branch}@${repo})`;
    process.env.BUILD_INFO = build;
    logger.info({ build, status, changes }, "Got build info from Git.");
  } catch (error: any) {
    logger.error(
      {
        error,
        stdout: error.stdout?.toString(),
        stderr: error.stderr?.toString(),
      },
      "Failed to get commit SHA.",
      error
    );
    process.env.BUILD_INFO = "unknown";
  }
}

start();
