export class QueryAlreadyDefinedError extends Error {
  readonly query: string;

  constructor(query: string) {
    super(`Query "${query}" is already defined`);
    this.name = 'QueryAlreadyDefinedError';
    this.query = query;
  }
}

export class QueryNotDefinedError extends Error {
  readonly query: string;

  constructor(query: string) {
    super(`Query "${query}" is not defined`);
    this.name = 'QueryNotDefinedError';
    this.query = query;
  }
}
