export const bedrockCompletionsResponse = {
  contentType: "application/json",
  body: JSON.stringify({
    id: "bedrock-response-id",
    model: "anthropic.claude-v2",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "This is a test response from Bedrock."
        },
        finish_reason: "stop"
      }
    ],
    usage: {
      prompt_tokens: 12,
      completion_tokens: 8,
      total_tokens: 20
    }
  })
};

export const bedrockFunctionCallResponse = {
  contentType: "application/json",
  body: JSON.stringify({
    id: "bedrock-function-call-id",
    model: "anthropic.claude-v2",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              type: "function",
              function: {
                name: "get_current_weather",
                arguments: JSON.stringify({
                  location: "Seattle, WA",
                  unit: "fahrenheit"
                })
              }
            }
          ]
        },
        finish_reason: "tool_calls"
      }
    ],
    usage: {
      prompt_tokens: 90,
      completion_tokens: 25,
      total_tokens: 115
    }
  })
};