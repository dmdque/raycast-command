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
} from "@raycast/api";
import { useState, useEffect } from "react";
import Anthropic from "@anthropic-ai/sdk";

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

Examples:
User: "find all js files modified in the last day"
Output: find . -name "*.js" -mtime -1

User: "list disk usage sorted by size"
Output: du -sh * | sort -h

User: "kill process on port 3000"
Output: lsof -ti:3000 | xargs kill -9`;

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

      const message = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 256,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: prompt }],
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
                  <Action title="Generate & Paste" onAction={() => generateCommand(item)} />
                  <Action
                    title="Edit Prompt"
                    onAction={() => setSearchText(item)}
                    shortcut={{ modifiers: ["cmd"], key: "e" }}
                  />
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
