import { ConsoleLogger, type LoggerService } from '@nestjs/common';

/** JSON logs in production (CloudWatch friendly), pretty logs locally. */
export function createLogger(): LoggerService {
  const json = process.env.LOG_FORMAT ? process.env.LOG_FORMAT === 'json' : process.env.NODE_ENV === 'production';
  return new ConsoleLogger({ json, prefix: 'flagship-api', logLevels: ['log', 'warn', 'error', 'fatal'] });
}
