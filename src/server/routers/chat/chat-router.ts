import { assistantPrompt } from '@/lib/prompt-utils'
import { XmlPrompt } from '@/lib/xml-prompt'
import {
  convertToModelMessages,
  createIdGenerator,
  createUIMessageStream,
  createUIMessageStreamResponse,
  smoothStream,
  stepCountIs,
  streamText,
  UIMessage
} from 'ai'
import { format } from 'date-fns'
import 'diff-match-patch-line-and-word'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import { redis } from '../../../lib/redis'
import { j, privateProcedure } from '../../jstack'
import { create_read_website_content } from './read-website-content'
import { parseAttachments } from './utils'

import { PayloadTweet } from '@/hooks/use-tweets-v2'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import { Ratelimit } from '@upstash/ratelimit'
import { getAccount } from '../utils/get-account'
import { createTweetTool } from './tools/create-tweet-tool'

const openrouter = createOpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY,
})

export interface WebScrapingResult {
  url: string
  content?: string
  screenshot?: string
  error?: string
}

// ==================== Schemas ====================

const attachmentSchema = z.object({
  id: z.string(),
  title: z.string().optional().nullable(),
  fileKey: z.string().optional(), // only for chat attachments
  type: z.enum(['url', 'txt', 'docx', 'pdf', 'image', 'manual', 'video']),
  variant: z.enum(['knowledge', 'chat']),
})

export type TAttachment = z.infer<typeof attachmentSchema>

const messageMetadataSchema = z.object({
  attachments: z.array(attachmentSchema).optional(),
  length: z.enum(['short', 'long', 'thread']),
})

export type Attachment = z.infer<typeof attachmentSchema>
export type MessageMetadata = z.infer<typeof messageMetadataSchema>

export type Metadata = {
  userMessage: string
  attachments: Array<TAttachment>
  tweets: PayloadTweet[]
  length: 'short' | 'long' | 'thread'
}

export interface ChatHistoryItem {
  id: string
  title: string
  lastUpdated: string
}

export type MyUIMessage = UIMessage<
  Metadata,
  {
    'main-response': {
      text: string
      status: 'streaming' | 'complete'
    }
    'tool-output': {
      text: string
      index: number
      status: 'processing' | 'streaming' | 'complete'
    }
    write_tweet: {
      status: 'processing'
    }
  },
  {
    read_website_content: {
      input: { website_url: string }
      output: {
        url: string
        title: string
        content: string
      }
    }
    lookup_involved_project: {
      input: { involved_project_name: string }
      output: string[]
    }
  }
>
// ==================== Route Handlers ====================

export const chatRouter = j.router({
  get_message_history: privateProcedure
    .input(z.object({ chatId: z.string().nullable() }))
    .get(async ({ c, input, ctx }) => {
      const { chatId } = input

      if (!chatId) {
        return c.superjson({ messages: [] })
      }

      const messages = await redis.get<MyUIMessage[]>(`chat:history:${chatId}`)

      if (!messages) {
        return c.superjson({ messages: [] })
      }

      return c.superjson({ messages })
    }),

  history: privateProcedure.query(async ({ c, ctx }) => {
    const { user } = ctx

    const historyKey = `chat:history-list:${user.email}`
    const chatHistory = (await redis.get<ChatHistoryItem[]>(historyKey)) || []

    return c.superjson({
      chatHistory: chatHistory.slice(0, 20),
    })
  }),

  chat: privateProcedure
    .input(
      z.object({
        message: z.any(),
        id: z.string(),
      }),
    )
    .post(async ({ c, ctx, input }) => {
      const { user } = ctx
      const { id, message } = input as { message: MyUIMessage; id: string }

      const limiter =
        user.plan === 'pro'
          ? new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(80, '4h') })
          : new Ratelimit({ redis, limiter: Ratelimit.fixedWindow(5, '1d') })

      const [account, history, parsedAttachments, limitResult] = await Promise.all([
        getAccount({ email: user.email }),
        redis.get<MyUIMessage[]>(`chat:history:${id}`),
        parseAttachments({
          attachments: message.metadata?.attachments,
        }),
        limiter.limit(user.email),
      ])

      if (process.env.NODE_ENV === 'production') {
        const { success } = limitResult

        if (!success) {
          if (user.plan === 'pro') {
            throw new HTTPException(429, {
              message: `You've reached a rate-limit. Please try again soon.`,
            })
          } else {
            throw new HTTPException(429, {
              message: 'Free plan limit reached, please upgrade to continue.',
            })
          }
        }
      }

      if (!account) {
        throw new HTTPException(412, { message: 'No connected account' })
      }

      const { links, attachments } = parsedAttachments

      const content = new XmlPrompt()
      const userContent = message.parts.reduce(
        (acc, curr) => (curr.type === 'text' ? acc + curr.text : ''),
        '',
      )

      content.open('message', { date: format(new Date(), 'EEEE, yyyy-MM-dd') })

      content.tag('user_message', userContent)

      if (Boolean(links.length)) {
        content.open('attached_links', { note: 'please read these links.' })
        links.filter(Boolean).forEach((l) => content.tag('link', l.link))
        content.close('attached_links')
      }

      if (message.metadata?.tweets) {
        if (message.metadata.tweets[0] && message.metadata.tweets.length === 1) {
          // single tweet
          content.tag('tweet_draft', message.metadata.tweets[0].content)
        } else if (message.metadata.tweets.length > 1) {
          content.open('thread_draft', { note: 'please read this thread.' })
          message.metadata.tweets.forEach((tweet) => {
            content.tag('tweet_draft', tweet.content, {
              index: tweet.index,
            })
          })
          content.close('thread_draft')
        }
      }

      content.close('message')

      // const sitemaps = await redis.hgetall<Record<string, { name: string; url: string }>>(
      //   `sitemaps:${user.email}`,
      // )

      // if (sitemaps) {
      //   content.open('involved_projects', {
      //     note: 'These are provided by the system. They may or may not be relevant to the user query, it is upon you to decide.',
      //   })
      //   Object.entries(sitemaps).map(([key, sitemap]) =>
      //     content.tag('involved_project', sitemap.name, {
      //       name: sitemap.name,
      //       involved_project_id: key,
      //     }),
      //   )
      //   content.close('involved_projects')
      // }

      // const lookup_involved_project = tool({
      //   description: `Use this tool when the user asks to tweet about an <involved_project />. Also required for vague requests like "tweet about <involved_project />", "what should I tweet today about <involved_project />". Always use this first before offering tweet suggestions. Under the hood, this tool holds a collection of all relevant URLs of a project the user is involved in.`,
      //   inputSchema: z.object({
      //     involved_project_id: z.string(),
      //     topic: z.string().describe("The topic to search, e.g. 'markdown streaming'."),
      //   }),
      //   execute: async ({ topic, involved_project_id }) => {
      //     const namespace = vector.namespace(`sitemap:${involved_project_id}`)

      //     const res = await namespace.query({
      //       data: topic,
      //       topK: 20,
      //       includeData: true,
      //       includeMetadata: true,
      //     })

      //     const links = res.map((doc) => doc.data).filter(Boolean)

      //     console.log('OUTPUT LINKS', links)

      //     return links
      //   },
      // })

      const userMessage: MyUIMessage = {
        ...message,
        parts: [{ type: 'text', text: content.toString() }, ...attachments],
      }

      const messages = [...(history ?? []), userMessage] as MyUIMessage[]

      const stream = createUIMessageStream<MyUIMessage>({
        originalMessages: messages,
        generateId: createIdGenerator({
          prefix: 'msg',
          size: 16,
        }),
        onFinish: async ({ messages }) => {
          await redis.set(`chat:history:${id}`, messages)
          await redis.del(`website-contents:${id}`)

          const historyKey = `chat:history-list:${user.email}`
          const existingHistory = (await redis.get<ChatHistoryItem[]>(historyKey)) || []

          const title = messages[0]?.metadata?.userMessage ?? 'Unnamed chat'

          const chatHistoryItem: ChatHistoryItem = {
            id,
            title,
            lastUpdated: new Date().toISOString(),
          }

          const updatedHistory = [
            chatHistoryItem,
            ...existingHistory.filter((item) => item.id !== id),
          ]

          await redis.set(historyKey, updatedHistory)
        },
        onError(error) {
          console.log('❌❌❌ ERROR:', JSON.stringify(error, null, 2))

          throw new HTTPException(500, {
            message: error instanceof Error ? error.message : 'Something went wrong.',
          })
        },
        execute: async ({ writer }) => {
          const generationId = crypto.randomUUID()
          // tools
          const write_tweet = createTweetTool({
            writer,
            ctx: {
              plan: user.plan as 'free' | 'pro',
              tweets: message.metadata?.tweets ?? [],
              instructions: userContent,
              messages,
              userContent,
              userId: user.id,
              attachments: { attachments, links },
              length: message.metadata?.length ?? 'long',
              redisKeys: {
                thread: `thread:${id}:${generationId}`,
                style: `style:${user.email}:${account.id}`,
                account: `active-account:${user.email}`,
                websiteContent: `website-contents:${id}`,
              },
            },
          })

          const read_website_content = create_read_website_content({ chatId: id })

          const result = streamText({
            model: openrouter.chat('openai/gpt-4.1', {
              models: ['openai/gpt-4o'],
              reasoning: { enabled: false, effort: 'low' },
            }),
            system: assistantPrompt({ tweets: message.metadata?.tweets ?? [] }),
            messages: convertToModelMessages(messages),
            tools: {
              write_tweet,
              read_website_content,
              // ...(sitemaps ? { lookup } : undefined),
            },
            stopWhen: stepCountIs(5),
            experimental_transform: smoothStream({
              delayInMs: 20,
              chunking: /[^-]*---/,
            }),
          })

          writer.merge(result.toUIMessageStream())
        },
      })

      return createUIMessageStreamResponse({ stream })
    }),
})
