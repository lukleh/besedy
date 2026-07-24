export type RecordingSourceType = "url" | "file";

export interface RecordingSourceBase {
  id: string;
  type: RecordingSourceType;
  createdAt: string;
  updatedAt?: string;
}

export interface RecordingSourceUrl extends RecordingSourceBase {
  type: "url";
  title: string;
  url: string;
}

export interface RecordingSourceFile extends RecordingSourceBase {
  type: "file";
  storedName: string;
  originalName: string;
  size: number;
  mimeType?: string | null;
}

export type RecordingSource = RecordingSourceUrl | RecordingSourceFile;
