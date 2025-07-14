import { AgentContext, routeAgentRequest, Schedule } from 'agents';
import { AIChatAgent } from 'agents/ai-chat-agent';
import { createDataStreamResponse, generateId, streamText, StreamTextOnFinishCallback, tool, Tool, ToolSet } from 'ai';
import { processToolCalls } from './utils';
import { openai } from '@ai-sdk/openai';
import { z } from 'zod';

const model = openai('o4-mini');

const storedLessonSchema = z.object({
  date: z.string().describe('The date of the lesson'),
  notes: z.array(z.string()).describe('The notes taken during the lesson'),
});

export class Chat extends AIChatAgent<Env> {
  private tools: ToolSet;

  constructor(context: AgentContext, env: Env) {
    super(context, env);

    const lessonKv = env.STUDY_APP_KV;

    this.tools = {
      getLessonInfo: tool({
        description: 'Get the metadata for every lesson',
        parameters: z.object({}),
        execute: async () => {
          console.log('Fetching lesson metadata from KV store');
          const lessons = await lessonKv.list({ prefix: 'lesson:' });

          console.log({ lessons });

          return lessons.keys.map((key) => ({
            term: key.name.split(':')[1],
            lessonNumber: key.name.split(':')[2],
          }));
        },
      }),
      getLessonNotes: tool({
        description: 'Get the notes for a specific lesson',
        parameters: z.object({
          lessonNumber: z.number().min(1).describe('The lesson number to get notes for'),
          termNumber: z.number().min(1).describe('The term number to get notes for'),
        }),
        execute: async ({ lessonNumber, termNumber }) => {
          console.log(`Fetching notes for lesson ${lessonNumber} in term ${termNumber}`);

          const key = `lesson:${termNumber}:${lessonNumber}`;

          const data = await lessonKv.get(key);

          if (!data) {
            throw new Error(`No notes found for lesson ${lessonNumber} in term ${termNumber}`);
          }

          const parseResult = storedLessonSchema.safeParse(JSON.parse(data));

          if (!parseResult.success) {
            throw new Error(`Invalid lesson data for lesson ${lessonNumber} in term ${termNumber}. Error: ${parseResult.error.message}`);
          }

          return parseResult.data;
        },
      }),
    };
  }

  async onChatMessage(onFinish: StreamTextOnFinishCallback<ToolSet>, _options?: { abortSignal?: AbortSignal }) {
    console.log('onChatMessage called with messages:', this.messages[this.messages.length - 1]);
    // Collect all tools, including MCP tools
    const allTools = {
      ...this.tools,
      ...this.mcp.unstable_getAITools(),
    };

    // Create a streaming response that handles both text and tool outputs
    const dataStreamResponse = createDataStreamResponse({
      execute: async (dataStream) => {
        console.log('Executing onChatMessage with messages');
        // Process any pending tool calls from previous messages
        // This handles human-in-the-loop confirmations for tools
        const processedMessages = await processToolCalls({
          messages: this.messages,
          dataStream,
          tools: allTools,
          executions: {},
        });

        console.log('processed tool calls. Calling LLM...');

        // Stream the AI response using GPT-4
        const result = streamText({
          model,
          system:
            'You are a helpful assistant that helps students learn European Portuguese. ' +
            'Your task is to help the student with their studies by answering their questions, ' +
            'providing explanations, and giving examples. You should be friendly and encouraging, ' +
            'and always try to help the student understand the material better. You should always load' +
            "the student's notes from the `study-app` mcp server before answering their question, " +
            'and you can use the tools to add new notes or update existing ones. Use the `study-notes` ' +
            'resource to load the notes. Do not use any other tools or resources. Always give your replies' +
            'in markdown. You should speak in English, but you can use Portuguese words and phrases when necessary.',
          messages: processedMessages,
          tools: allTools,
          onFinish: async (args) => {
            console.log('AI response finished:', args);
            onFinish(args as Parameters<StreamTextOnFinishCallback<ToolSet>>[0]);
            // await this.mcp.closeConnection(mcpConnection.id);
          },
          onError: (error) => {
            console.error('Error while streaming:', error);
          },
          maxSteps: 10,
        });

        // Merge the AI response stream with tool execution outputs
        result.mergeIntoDataStream(dataStream);
      },
    });

    return dataStreamResponse;
  }

  async executeTask(description: string, _task: Schedule<string>) {
    await this.saveMessages([
      ...this.messages,
      {
        id: generateId(),
        role: 'user',
        content: `Running scheduled task: ${description}`,
        createdAt: new Date(),
      },
    ]);
  }
}

export default {
  async fetch(request, env, _ctx): Promise<Response> {
    const allowedOrigins = env.ALLOWED_ORIGINS?.split(',') || [];
    const origin = request.headers.get('origin');

    console.log('Request received:', request);

    return (
      (await routeAgentRequest(request, env, {
        cors: {
          'Access-Control-Allow-Origin': origin && allowedOrigins.includes(origin) ? origin : allowedOrigins[0],
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      })) || new Response('Not found', { status: 404 })
    );
  },
} satisfies ExportedHandler<Env>;
