import { query } from "@anthropic-ai/claude-agent-sdk";

const BASE =
  process.env.CLAUDE_PETS_BASE ||
  // Back-compat: if only CLAUDE_PETS_URL was set (it pointed at /approve), strip it.
  (process.env.CLAUDE_PETS_URL || "").replace(/\/approve\/?$/, "") ||
  "http://127.0.0.1:47777";
const APPROVE_URL = `${BASE}/approve`;
const EVENT_URL = `${BASE}/event`;
const SHOULD_CONTINUE = process.env.CLAUDE_PETS_CONTINUE === "1";

function postEvent(event) {
  // Fire-and-forget. Errors are non-fatal — the agent is still useful even if
  // the renderer can't be reached.
  fetch(EVENT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event),
  }).catch(() => {});
}

function summarize(toolName, input) {
  switch (toolName) {
    case "Read":  return { title: `Read file`,    content: input.file_path || "" };
    case "Write": return { title: `Write file`,   content: input.file_path || "" };
    case "Edit":  return { title: `Edit file`,    content: input.file_path || "" };
    case "Bash":  return { title: `Bash command`, content: String(input.command ?? "") };
    case "Glob":  return { title: `Glob pattern`, content: String(input.pattern ?? "") };
    case "Grep":  return { title: `Grep pattern`, content: String(input.pattern ?? "") };
    default:      return { title: `Use tool ${toolName}`, content: "" };
  }
}

function buildOptions(toolName, hasSuggestions) {
  const opts = [{ id: "allow", label: "1. Yes" }];
  if (hasSuggestions) {
    opts.push({
      id: "allow_session",
      label: `2. Yes, and don't ask again for ${toolName} this session`,
    });
    opts.push({ id: "deny", label: "3. No, and tell Claude what to do differently" });
  } else {
    opts.push({ id: "deny", label: "2. No, and tell Claude what to do differently" });
  }
  return opts;
}

async function askPet(payload) {
  let res;
  try {
    res = await fetch(APPROVE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    throw new Error(
      `Could not reach Claude Pets at ${APPROVE_URL}. Is the daemon running?\n${err.message}`
    );
  }
  if (!res.ok) {
    throw new Error(`Claude Pets responded ${res.status} ${res.statusText}`);
  }
  return await res.json();
}

const task = process.argv.slice(2).join(" ").trim();
if (!task) {
  console.error("usage: claude-pets <task>");
  process.exit(1);
}

postEvent({ type: "status", state: "working" });
postEvent({ type: "user-task", text: task });

const result = query({
  prompt: task,
  options: {
    continue: SHOULD_CONTINUE,
    canUseTool: async (toolName, input, opts) => {
      const { title, content } = summarize(toolName, input);
      const message = opts.title || title;
      const suggestions = opts.suggestions || [];
      const options = buildOptions(toolName, suggestions.length > 0);

      process.stderr.write(`\n[pet] ${message}${content ? `: ${content}` : ""}\n`);
      const { choice, feedback } = await askPet({ message, content, options });
      process.stderr.write(`[pet] choice: ${choice}\n`);

      if (choice === "allow") {
        return { behavior: "allow", updatedInput: input };
      }
      if (choice === "allow_session") {
        return {
          behavior: "allow",
          updatedInput: input,
          updatedPermissions: suggestions,
        };
      }
      return {
        behavior: "deny",
        message: feedback || "User declined via Claude Pets",
      };
    },
  },
});

let turnText = "";
try {
  for await (const msg of result) {
    if (msg.type === "assistant") {
      for (const block of msg.message.content ?? []) {
        if (block.type === "text") {
          process.stdout.write(block.text);
          turnText += block.text;
        }
      }
    } else if (msg.type === "result") {
      process.stdout.write("\n");
      if (turnText.trim()) {
        postEvent({ type: "message", text: turnText.trim() });
      }
      if (msg.subtype !== "success") {
        process.stderr.write(`[ended: ${msg.subtype}]\n`);
      }
    }
  }
} finally {
  postEvent({ type: "status", state: "idle" });
}
