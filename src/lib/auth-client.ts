import { createAuthClient } from 'better-auth/react'
import { inferAdditionalFields, magicLinkClient } from 'better-auth/client/plugins'

export const authClient = createAuthClient({
  plugins: [
    magicLinkClient(),
    inferAdditionalFields({
      user: {
        plan: { type: 'string', defaultValue: 'free' },
        isAdmin: { type: 'boolean', defaultValue: false },
      },
    }),
  ],
})
