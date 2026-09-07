/**
 * フォルダ名だけを取得するための共通ヘルパー。
 * showDirectoryPicker (File System Access API) を使うと、フォルダ内のファイルを
 * 列挙・読み込みせずに、選択したフォルダの名前だけを取得できる(Chrome/Edge対応)。
 * 非対応ブラウザの場合は null を返すので、呼び出し側で従来の
 * <input type="file" webkitdirectory> 方式にフォールバックすること。
 */
export async function pickFolderNameViaDirectoryPicker(): Promise<string | null> {
  if (!("showDirectoryPicker" in window)) {
    return null;
  }
  try {
    const handle = await (window as unknown as { showDirectoryPicker: () => Promise<{ name: string }> }).showDirectoryPicker();
    return handle.name;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      // ユーザーがキャンセルした場合は何もしない
      return null;
    }
    throw err;
  }
}

export function isDirectoryPickerSupported(): boolean {
  return "showDirectoryPicker" in window;
}
