import { ObjectId } from 'mongodb';

export interface EncryptedSessionPayload {
  uri: string;
  databaseName: string;
  allowedScope: string[];
  readOnly: boolean;
  iat: number;
  exp: number;
}

export interface ConnectionResult {
  success: boolean;
  databaseName?: string;
  databases?: string[];
  error?: string;
}

export interface CollectionInfo {
  name: string;
  documentCount: number;
  size: number;
}

export interface DocumentResult {
  documents: unknown[];
  totalCount?: number;
  hasMore: boolean;
}

export interface QueryOptions {
  database: string;
  collection: string;
  filter?: Record<string, unknown>;
  sort?: Record<string, 1 | -1>;
  limit?: number;
  skip?: number;
  projection?: Record<string, 1 | 0>;
}

export interface InsertOptions {
  database: string;
  collection: string;
  document: Record<string, unknown>;
}

export interface UpdateOptions {
  database: string;
  collection: string;
  id: string;
  update: Record<string, unknown>;
}

export interface DeleteOptions {
  database: string;
  collection: string;
  id: string;
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export function isValidObjectId(id: string): boolean {
  try {
    return ObjectId.isValid(id) && new ObjectId(id).toString() === id;
  } catch {
    return false;
  }
}
