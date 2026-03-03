function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizeContentPart(part: unknown): unknown {
  if (typeof part === "string") {
    return {
      type: "text",
      text: part
    };
  }

  if (!isRecord(part)) {
    return part;
  }

  const type = asString(part["type"]);
  if (type === "text") {
    return {
      type: "text",
      text: asString(part["text"]) ?? ""
    };
  }

  if (type === "image_url") {
    const imageData = isRecord(part["image_url"]) ? part["image_url"] : null;
    const imageUrl = asString(imageData?.["url"]) ?? asString(part["image_url"]);
    if (!imageUrl) {
      return part;
    }

    return {
      type: "image",
      source: {
        type: "url",
        url: imageUrl
      }
    };
  }

  return part;
}

function normalizeMessageContent(content: unknown): unknown {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return content;
  }

  return content.map((part) => normalizeContentPart(part));
}

function contentToText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    if (content === null || content === undefined) {
      return "";
    }
    return stringifyUnknown(content);
  }

  return content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }

      if (!isRecord(part)) {
        return "";
      }

      if (asString(part["type"]) !== "text") {
        return "";
      }

      return asString(part["text"]) ?? "";
    })
    .join("");
}

function normalizeMessageContentToParts(content: unknown): Record<string, unknown>[] {
  if (typeof content === "string") {
    if (content.length === 0) {
      return [];
    }

    return [{
      type: "text",
      text: content
    }];
  }

  if (!Array.isArray(content)) {
    if (content === null || content === undefined) {
      return [];
    }

    return [{
      type: "text",
      text: stringifyUnknown(content)
    }];
  }

  return content
    .map((part) => normalizeContentPart(part))
    .map((part) => {
      if (typeof part === "string") {
        return {
          type: "text",
          text: part
        };
      }

      return part;
    })
    .filter((part): part is Record<string, unknown> => {
      if (!isRecord(part)) {
        return false;
      }

      const type = asString(part["type"]);
      if (!type) {
        return false;
      }

      if (type !== "text") {
        return true;
      }

      const text = asString(part["text"]);
      return text !== undefined && text.length > 0;
    });
}

function parseToolUseInput(argumentsValue: unknown): Record<string, unknown> {
  if (isRecord(argumentsValue)) {
    return argumentsValue;
  }

  if (typeof argumentsValue === "string") {
    try {
      const parsed = JSON.parse(argumentsValue);
      if (isRecord(parsed)) {
        return parsed;
      }

      if (parsed === null || parsed === undefined) {
        return {};
      }

      return { value: parsed };
    } catch {
      return { value: argumentsValue };
    }
  }

  if (argumentsValue === null || argumentsValue === undefined) {
    return {};
  }

  return { value: argumentsValue };
}

function assistantToolCallsToToolUseParts(toolCalls: unknown): Record<string, unknown>[] {
  if (!Array.isArray(toolCalls)) {
    return [];
  }

  const parts: Record<string, unknown>[] = [];
  for (const [index, toolCall] of toolCalls.entries()) {
    if (!isRecord(toolCall)) {
      continue;
    }

    const type = asString(toolCall["type"]) ?? "function";
    if (type !== "function") {
      continue;
    }

    const fn = isRecord(toolCall["function"]) ? toolCall["function"] : null;
    const name = fn ? asString(fn["name"]) : undefined;
    if (!name) {
      continue;
    }

    const id = asString(toolCall["id"]) ?? `toolu_${index}`;
    const input = parseToolUseInput(fn ? fn["arguments"] : undefined);
    parts.push({
      type: "tool_use",
      id,
      name,
      input
    });
  }

  return parts;
}

function mapAssistantMessage(message: Record<string, unknown>): Record<string, unknown> | null {
  const contentParts = normalizeMessageContentToParts(message["content"]);
  const toolUseParts = assistantToolCallsToToolUseParts(message["tool_calls"]);
  const content = [...contentParts, ...toolUseParts];

  if (content.length === 0) {
    return null;
  }

  const first = content[0];
  if (toolUseParts.length === 0 && content.length === 1 && asString(first["type"]) === "text") {
    return {
      role: "assistant",
      content: asString(first["text"]) ?? ""
    };
  }

  return {
    role: "assistant",
    content
  };
}

function mapToolMessageToToolResult(message: Record<string, unknown>, index: number): Record<string, unknown> | null {
  const toolUseId = asString(message["tool_call_id"]);
  if (!toolUseId) {
    return null;
  }

  const block: Record<string, unknown> = {
    type: "tool_result",
    tool_use_id: toolUseId,
    content: contentToText(message["content"])
  };

  const isError = message["is_error"];
  if (typeof isError === "boolean") {
    block["is_error"] = isError;
  }

  if (asString(block["tool_use_id"]) === undefined) {
    block["tool_use_id"] = `toolu_${index}`;
  }

  return block;
}

function normalizeToolChoice(toolChoice: unknown): unknown {
  if (typeof toolChoice === "string") {
    if (toolChoice === "required" || toolChoice === "auto") {
      return { type: "any" };
    }
    if (toolChoice === "none") {
      return { type: "none" };
    }
    return toolChoice;
  }

  if (!isRecord(toolChoice)) {
    return toolChoice;
  }

  const type = asString(toolChoice["type"]);
  if (type === "function") {
    const functionConfig = isRecord(toolChoice["function"]) ? toolChoice["function"] : null;
    const name = functionConfig ? asString(functionConfig["name"]) : asString(toolChoice["name"]);
    if (!name) {
      return { type: "any" };
    }

    return {
      type: "tool",
      name
    };
  }

  if (type === "required") {
    return { type: "any" };
  }

  if (type === "auto") {
    return { type: "any" };
  }

  if (type === "none") {
    return { type: "none" };
  }

  return toolChoice;
}

function normalizeTools(tools: unknown): unknown {
  if (!Array.isArray(tools)) {
    return tools;
  }

  return tools
    .map((tool) => {
      if (!isRecord(tool)) {
        return null;
      }

      const type = asString(tool["type"]) ?? "function";
      if (type !== "function") {
        return null;
      }

      const functionData = isRecord(tool["function"]) ? tool["function"] : null;
      const name = functionData ? asString(functionData["name"]) : asString(tool["name"]);
      if (!name) {
        return null;
      }

      const mapped: Record<string, unknown> = {
        name
      };

      const description = functionData ? asString(functionData["description"]) : asString(tool["description"]);
      if (description) {
        mapped["description"] = description;
      }

      const parameters = functionData?.["parameters"] ?? tool["input_schema"];
      if (parameters !== undefined) {
        mapped["input_schema"] = parameters;
      }

      return mapped;
    })
    .filter((tool): tool is Record<string, unknown> => tool !== null);
}

export function shouldUseMessagesUpstream(model: unknown, prefixes: readonly string[]): boolean {
  if (typeof model !== "string") {
    return false;
  }

  const lower = model.toLowerCase();
  return prefixes.some((prefix) => lower.startsWith(prefix.toLowerCase()));
}

export function chatRequestToMessagesRequest(body: Record<string, unknown>): Record<string, unknown> {
  let system: string | undefined;
  const messages: Record<string, unknown>[] = [];
  let pendingToolResults: Record<string, unknown>[] = [];

  const flushToolResults = () => {
    if (pendingToolResults.length === 0) {
      return;
    }

    messages.push({
      role: "user",
      content: pendingToolResults
    });
    pendingToolResults = [];
  };

  if (Array.isArray(body["messages"])) {
    for (const [index, rawMessage] of body["messages"].entries()) {
      if (!isRecord(rawMessage)) {
        continue;
      }

      const role = asString(rawMessage["role"]) ?? "user";
      if (role === "system") {
        const text = contentToText(normalizeMessageContent(rawMessage["content"]));
        if (text.length > 0) {
          system = system ? `${system}\n${text}` : text;
        }
        continue;
      }

      if (role === "tool") {
        const toolResult = mapToolMessageToToolResult(rawMessage, index);
        if (toolResult) {
          pendingToolResults.push(toolResult);
        }
        continue;
      }

      flushToolResults();

      if (role === "assistant") {
        const assistant = mapAssistantMessage(rawMessage);
        if (assistant) {
          messages.push(assistant);
        }
        continue;
      }

      if (role === "user") {
        messages.push({
          role,
          content: normalizeMessageContent(rawMessage["content"] ?? "")
        });
      }
    }
  }

  flushToolResults();

  const payload: Record<string, unknown> = {
    model: body["model"],
    messages,
    stream: false
  };

  if (system && system.trim().length > 0) {
    payload["system"] = system;
  }

  const maxTokens = asNumber(body["max_completion_tokens"]) ?? asNumber(body["max_tokens"]);
  if (maxTokens !== undefined) {
    payload["max_tokens"] = maxTokens;
  }

  const temperature = body["temperature"];
  if (temperature !== undefined) {
    payload["temperature"] = temperature;
  }

  const topP = body["top_p"];
  if (topP !== undefined) {
    payload["top_p"] = topP;
  }

  if (body["tools"] !== undefined) {
    payload["tools"] = normalizeTools(body["tools"]);
  }

  if (body["tool_choice"] !== undefined) {
    payload["tool_choice"] = normalizeToolChoice(body["tool_choice"]);
  }

  return payload;
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => {
      if (!isRecord(part)) {
        return "";
      }
      if (asString(part["type"]) !== "text") {
        return "";
      }
      return asString(part["text"]) ?? "";
    })
    .join("");
}

interface ChatToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly arguments: string;
  };
}

function mapToolCalls(content: unknown): ReadonlyArray<ChatToolCall> {
  if (!Array.isArray(content)) {
    return [];
  }

  return content
    .map<ChatToolCall | null>((part, index) => {
      if (!isRecord(part)) {
        return null;
      }

      if (asString(part["type"]) !== "tool_use") {
        return null;
      }

      const name = asString(part["name"]);
      if (!name) {
        return null;
      }

      const callId = asString(part["id"]) ?? `call_${index}`;
      const input = part["input"];

      return {
        id: callId,
        type: "function",
        function: {
          name,
          arguments: typeof input === "string" ? input : JSON.stringify(input ?? {})
        }
      };
    })
    .filter((entry): entry is ChatToolCall => entry !== null);
}

export function messagesToChatCompletion(body: unknown, fallbackModel: string): Record<string, unknown> {
  if (!isRecord(body)) {
    throw new Error("Invalid /v1/messages response payload");
  }

  const content = body["content"];
  const toolCalls = mapToolCalls(content);
  const text = extractTextContent(content);

  const finishReason = toolCalls.length > 0 ? "tool_calls" : "stop";
  const message: Record<string, unknown> = {
    role: "assistant",
    content: toolCalls.length > 0 ? (text.length > 0 ? text : null) : text
  };
  if (toolCalls.length > 0) {
    message["tool_calls"] = toolCalls;
  }

  const usage = isRecord(body["usage"]) ? body["usage"] : null;
  const promptTokens = usage ? asNumber(usage["input_tokens"]) : undefined;
  const completionTokens = usage ? asNumber(usage["output_tokens"]) : undefined;
  const totalTokens =
    promptTokens !== undefined && completionTokens !== undefined
      ? promptTokens + completionTokens
      : undefined;

  const completion: Record<string, unknown> = {
    id: asString(body["id"]) ?? `chatcmpl_${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: asString(body["model"]) ?? fallbackModel,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason
      }
    ],
    system_fingerprint: ""
  };

  if (promptTokens !== undefined && completionTokens !== undefined && totalTokens !== undefined) {
    completion["usage"] = {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens
    };
  }

  return completion;
}
