import { routeAgentRequest, Schedule } from 'agents';
import { AIChatAgent } from 'agents/ai-chat-agent';
import { unstable_getSchedulePrompt } from 'agents/schedule';
import { createDataStreamResponse, generateId, streamText, StreamTextOnFinishCallback, ToolSet } from 'ai';
import { processToolCalls } from './utils';
import { executions, tools } from './tools';
import { openai } from '@ai-sdk/openai';

const model = openai('gpt-4-turbo');

export class Chat extends AIChatAgent<Env> {
	/**
	 * Handles incoming chat messages and manages the response stream
	 * @param onFinish - Callback function executed when streaming completes
	 */

	async onChatMessage(onFinish: StreamTextOnFinishCallback<ToolSet>, _options?: { abortSignal?: AbortSignal }) {
		// const mcpConnection = await this.mcp.connect(
		//   "https://path-to-mcp-server/sse"
		// );

		// Collect all tools, including MCP tools
		const allTools = {
			...tools,
			...this.mcp.unstable_getAITools(),
		};

		console.log({ allTools });

		// Create a streaming response that handles both text and tool outputs
		const dataStreamResponse = createDataStreamResponse({
			execute: async (dataStream) => {
				// Process any pending tool calls from previous messages
				// This handles human-in-the-loop confirmations for tools
				const processedMessages = await processToolCalls({
					messages: this.messages,
					dataStream,
					tools: allTools,
					executions,
				});

				// Stream the AI response using GPT-4
				const result = streamText({
					model,
					system: `You are a helpful assistant that can do various tasks... 

${unstable_getSchedulePrompt({ date: new Date() })}

If the user asks to schedule a task, use the schedule tool to schedule the task
`,
					messages: processedMessages,
					tools: allTools,
					onFinish: async (args) => {
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
		return (
			(await routeAgentRequest(request, env, {
				cors: {
					'Access-Control-Allow-Origin': 'http://localhost:5173',
					'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
					'Access-Control-Allow-Headers': 'Content-Type',
				},
			})) || new Response('Not found', { status: 404 })
		);
	},
} satisfies ExportedHandler<Env>;
