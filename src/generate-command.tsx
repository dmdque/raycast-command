import {
  List,
  ActionPanel,
  Action,
  showToast,
  Toast,
  getPreferenceValues,
  Clipboard,
  closeMainWindow,
  showHUD,
  Icon,
  LocalStorage,
  getSelectedText,
} from "@raycast/api";
import { useState, useEffect } from "react";
import Anthropic from "@anthropic-ai/sdk";
import { execSync } from "child_process";

interface Preferences {
  anthropicApiKey: string;
}

const HISTORY_KEY = "command-history";
const MAX_HISTORY = 20;

const SYSTEM_PROMPT = `You are a CLI command generator. Given a natural language description, output ONLY the exact command to run. No explanations, no markdown, no code blocks, no backticks - just the raw command itself.

Rules:
- Output only the command, nothing else
- If multiple commands are needed, chain them with && or ;
- Use common Unix conventions
- Prefer portable/POSIX commands when possible
- If the request is ambiguous, make a reasonable assumption and output a working command
- If context is provided (selected text, current app, current directory), use it to inform your command

Examples:
User: "find all js files modified in the last day"
Output: find . -name "*.js" -mtime -1

User: "list disk usage sorted by size"
Output: du -sh * | sort -h

User: "kill process on port 3000"
Output: lsof -ti:3000 | xargs kill -9`;

interface Context {
  selectedText?: string;
  currentApp?: string;
  currentDirectory?: string;
}

function runAppleScript(script: string): string | undefined {
  try {
    return execSync(`osascript -e '${script}'`, { encoding: "utf-8" }).trim();
  } catch {
    return undefined;
  }
}

async function gatherContext(): Promise<Context> {
  const context: Context = {};

  // Get selected text from previous app
  try {
    context.selectedText = await getSelectedText();
  } catch {
    // No text selected or not available
  }

  // Get the previous frontmost app (before Raycast)
  const appScript = `
    tell application "System Events"
      set appList to name of every application process whose visible is true and frontmost is false
      if (count of appList) > 0 then
        return item 1 of appList
      end if
    end tell
  `;
  context.currentApp = runAppleScript(appScript);

  // Get current directory from Terminal/iTerm if that's the previous app
  if (context.currentApp === "Terminal") {
    const dirScript = `tell application "Terminal" to get custom title of selected tab of front window`;
    const dir = runAppleScript(dirScript);
    if (!dir) {
      // Fallback: try to get from window name which often contains the path
      const windowScript = `tell application "Terminal" to get name of front window`;
      context.currentDirectory = runAppleScript(windowScript);
    } else {
      context.currentDirectory = dir;
    }
  } else if (context.currentApp === "iTerm2" || context.currentApp === "iTerm") {
    const dirScript = `tell application "iTerm2" to tell current session of current window to get variable named "path"`;
    context.currentDirectory = runAppleScript(dirScript);
  }

  return context;
}

function buildPrompt(userPrompt: string, context: Context): string {
  const parts: string[] = [];

  if (context.currentApp) {
    parts.push(`Current app: ${context.currentApp}`);
  }
  if (context.currentDirectory) {
    parts.push(`Current directory: ${context.currentDirectory}`);
  }
  if (context.selectedText) {
    parts.push(`Selected text:\n${context.selectedText}`);
  }

  if (parts.length > 0) {
    return `Context:\n${parts.join("\n")}\n\nRequest: ${userPrompt}`;
  }
  return userPrompt;
}

async function getHistory(): Promise<string[]> {
  const stored = await LocalStorage.getItem<string>(HISTORY_KEY);
  return stored ? JSON.parse(stored) : [];
}

async function addToHistory(prompt: string): Promise<string[]> {
  const history = await getHistory();
  const filtered = history.filter((h) => h !== prompt);
  const updated = [prompt, ...filtered].slice(0, MAX_HISTORY);
  await LocalStorage.setItem(HISTORY_KEY, JSON.stringify(updated));
  return updated;
}

export default function Command() {
  const [searchText, setSearchText] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [listKey, setListKey] = useState(0);

  useEffect(() => {
    getHistory().then(setHistory);
  }, []);

  async function generateCommand(prompt: string) {
    if (!prompt.trim()) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Please enter a description",
      });
      return;
    }

    setIsLoading(true);

    try {
      const preferences = getPreferenceValues<Preferences>();
      const client = new Anthropic({ apiKey: preferences.anthropicApiKey });

      const context = await gatherContext();
      const fullPrompt = buildPrompt(prompt, context);

      const message = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 256,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: fullPrompt }],
      });

      const command =
        message.content[0].type === "text" ? message.content[0].text.trim() : "";

      if (!command) {
        await showToast({
          style: Toast.Style.Failure,
          title: "No command generated",
        });
        setIsLoading(false);
        return;
      }

      const updatedHistory = await addToHistory(prompt);
      setHistory(updatedHistory);
      await closeMainWindow();
      await Clipboard.paste(command);
      await showHUD("Command pasted");
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      await showToast({
        style: Toast.Style.Failure,
        title: "Error",
        message: errorMessage,
      });
      setIsLoading(false);
    }
  }

  const filteredHistory = searchText.trim()
    ? history.filter((item) => item.toLowerCase().includes(searchText.toLowerCase()))
    : history;

  return (
    <List
      key={listKey}
      isLoading={isLoading}
      searchText={searchText}
      onSearchTextChange={setSearchText}
      searchBarPlaceholder="Describe the command you need..."
      filtering={false}
    >
      {searchText.trim() && (
        <List.Item
          icon={Icon.Terminal}
          title="Generate Command"
          subtitle={searchText}
          actions={
            <ActionPanel>
              <Action title="Generate & Paste" onAction={() => generateCommand(searchText)} />
            </ActionPanel>
          }
        />
      )}
      {filteredHistory.length > 0 && (
        <List.Section title="History">
          {filteredHistory.map((item, index) => (
            <List.Item
              key={index}
              icon={Icon.Clock}
              title={item}
              actions={
                <ActionPanel>
                  <Action title="Use Prompt" onAction={() => {
                    setSearchText(item);
                    setListKey((k) => k + 1);
                  }} />
                  <Action
                    title="Clear History"
                    style={Action.Style.Destructive}
                    shortcut={{ modifiers: ["cmd", "shift"], key: "backspace" }}
                    onAction={async () => {
                      await LocalStorage.removeItem(HISTORY_KEY);
                      setHistory([]);
                      await showToast({ title: "History cleared" });
                    }}
                  />
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      )}
    </List>
  );
}
