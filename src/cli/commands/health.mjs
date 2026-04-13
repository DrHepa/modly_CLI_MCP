export async function runHealthCommand(context) {
  const data = await context.client.health();

  return {
    data,
    humanMessage: `Backend OK — ${context.config.apiUrl}`,
  };
}
