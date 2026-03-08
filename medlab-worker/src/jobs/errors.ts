export class SoftError extends Error {
  constructor(public readonly code: string, public readonly messageSafe: string) {
    super(messageSafe);
  }
}

export class HardError extends Error {
  constructor(public readonly code: string, public readonly messageSafe: string) {
    super(messageSafe);
  }
}
