export interface ModerationRule<TContext> {
  readonly name: string;
  execute(context: TContext): Promise<boolean>;
}

/** Chain of Responsibility: stop after the first rule that handles a message. */
export async function runModerationPipeline<TContext>(
  rules: ReadonlyArray<ModerationRule<TContext>>,
  context: TContext
): Promise<void> {
  for (const rule of rules) {
    if (await rule.execute(context)) return;
  }
}
