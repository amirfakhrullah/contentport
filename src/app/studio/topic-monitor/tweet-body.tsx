import { EnrichedTweet } from 'react-tweet'
import { ReactNode } from 'react'
import { highlightText } from '@/lib/highlight-utils'
import { Keyword } from './feed-settings-modal'

type Props = {
  children: ReactNode
  href: string
}

export const TweetLink = ({ href, children }: Props) => (
  <a href={href} className="text-sm" target="_blank" rel="noopener noreferrer nofollow">
    {children}
  </a>
)

export const TweetBody = ({
  tweet,
  highlights,
}: {
  tweet: EnrichedTweet
  highlights: Keyword[]
}) => {
  const tweetText = tweet.entities.map(item => item.text).join('')
  const shouldShowEllipsis = tweetText.length > 275

  return (
    <p className="text-sm" lang={tweet.lang} dir="auto">
      {tweet.entities.map((item, i) => {
        switch (item.type) {
          case 'hashtag':
          case 'mention':
          case 'url':
          case 'symbol':
            return (
              <span key={i}>
                {highlights.length > 0 ? highlightText(item.text, highlights) : item.text}
              </span>
            )
          case 'media':
            return
          default:
            if (highlights.length > 0) {
              const highlightedContent = highlightText(item.text, highlights)
              return (
                <span key={i}>
                  {highlightedContent.map((content, idx) =>
                    typeof content === 'string' ? (
                      <span
                        className="whitespace-pre-wrap"
                        key={`${i}-${idx}`}
                        dangerouslySetInnerHTML={{ __html: content }}
                      />
                    ) : (
                      content
                    ),
                  )}
                </span>
              )
            }
            return (
              <span
                className="whitespace-pre-wrap"
                key={i}
                dangerouslySetInnerHTML={{ __html: item.text }}
              />
            )
        }
      })}
      {shouldShowEllipsis && <span>...</span>}
    </p>
  )
}
