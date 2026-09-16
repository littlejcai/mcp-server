/** Shared error types for skill-hub (mirror of hub/errors.py). */

export class SkillHubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillHubError";
  }
}

export class UnknownSkillError extends SkillHubError {
  constructor(message: string) {
    super(message);
    this.name = "UnknownSkillError";
  }
}

export class SkillInputError extends SkillHubError {
  constructor(message: string) {
    super(message);
    this.name = "SkillInputError";
  }
}

export class SkillExecutionError extends SkillHubError {
  constructor(message: string) {
    super(message);
    this.name = "SkillExecutionError";
  }
}

export class UnknownJobError extends SkillHubError {
  constructor(message: string) {
    super(message);
    this.name = "UnknownJobError";
  }
}
