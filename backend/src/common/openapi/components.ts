export const openApiSecuritySchemes = {
  bearerAuth: {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
    description: 'Access token з відповіді login або refresh.',
  },
  refreshCookie: {
    type: 'apiKey',
    in: 'cookie',
    name: 'refresh_token',
    description: 'HttpOnly refresh cookie, яку сервер встановлює під час login або refresh.',
  },
} as const;
