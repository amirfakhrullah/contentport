'use client'

import { cn } from '@/lib/utils'
import { HTMLAttributes } from 'react'
import Tweet from './tweet'

interface TweetEditorProps extends HTMLAttributes<HTMLDivElement> {
  id?: string | undefined
  initialContent?: string
  editMode?: boolean
}

export default function TweetEditor({
  id,
  initialContent,
  className,
  editMode = false,
  ...rest
}: TweetEditorProps) {
  return (
    <div className={cn('relative z-10 w-full rounded-lg font-sans', className)} {...rest}>
      <div className="space-y-4 w-full pb-40">
        <Tweet editMode={editMode} />
      </div>
    </div>
  )
}
