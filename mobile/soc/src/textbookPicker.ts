import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { Platform } from 'react-native';

export async function pickTextbook(): Promise<{ name: string; body: BodyInit } | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: ['application/pdf', 'application/epub+zip', 'application/octet-stream'],
    copyToCacheDirectory: true, multiple: false, base64: false,
  });
  if (result.canceled) return null;
  const asset = result.assets[0];
  if (!/\.(pdf|epub)$/i.test(asset.name)) throw new Error('请选择 PDF 或 EPUB 教材');
  const file = Platform.OS === 'web' ? asset.file : new File(asset.uri);
  if (!file) throw new Error('无法读取文件，请重新选择');
  if (file.size > 128 * 1024 * 1024) throw new Error('文件超过 128 MB，请拆分教材');
  return { name: asset.name, body: file as unknown as BodyInit };
}
