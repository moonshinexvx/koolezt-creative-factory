export function createLatestRequest<Input, Output>(options: Readonly<{
  load: (input: Input) => Promise<Output>;
  apply: (output: Output) => void;
  fail: (error: unknown) => void;
  loading: (active: boolean) => void;
}>) {
  let sequence = 0;
  return {
    async run(input: Input): Promise<boolean> {
      const request = ++sequence;
      options.loading(true);
      try {
        const output = await options.load(input);
        if (request !== sequence) return false;
        options.apply(output);
        options.fail(undefined);
        return true;
      } catch (error) {
        if (request === sequence) options.fail(error);
        return false;
      } finally {
        if (request === sequence) options.loading(false);
      }
    },
    cancel(): void {
      sequence += 1;
      options.loading(false);
    }
  };
}
