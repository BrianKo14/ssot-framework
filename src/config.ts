export interface AppConfig {
  databaseUrl: string;
  port: number;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

export function loadConfig(): AppConfig {
  return {
    databaseUrl: required('DATABASE_URL'),
    port: Number(process.env.PORT ?? 3000),
  };
}