declare module "s3rver" {
  export interface S3rverOptions {
    port: number;
    address: string;
    silent?: boolean;
    directory: string;
  }
  export default class S3rver {
    constructor(options: S3rverOptions);
    run(): Promise<{ address: string; port: number }>;
    close(): Promise<void>;
  }
}
