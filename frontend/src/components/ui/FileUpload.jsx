import React, { useRef, useEffect, useState } from 'react';
import { UploadCloud, X, Image as ImageIcon, FileText, ExternalLink } from 'lucide-react';
import { fileToBase64 } from '../../utils/format';
import { fetchAuthBlobUrl } from '../../services/api';

function isPdfSource(src) {
  if (!src) return false;
  const s = String(src).toLowerCase();
  return s.startsWith('data:application/pdf') || s.endsWith('.pdf');
}

export function AuthImage({ src, alt = 'Ảnh đính kèm', className = '' }) {
  const [resolvedSrc, setResolvedSrc] = useState(null);

  useEffect(() => {
    let active = true;
    let blobUrl = null;
    if (!src) {
      setResolvedSrc(null);
      return undefined;
    }
    if (src.startsWith('data:') || src.startsWith('http://') || src.startsWith('https://')) {
      setResolvedSrc(src);
      return undefined;
    }
    fetchAuthBlobUrl(src)
      .then((u) => {
        if (active) {
          blobUrl = u;
          setResolvedSrc(u);
        }
      })
      .catch(() => {
        if (active) setResolvedSrc(null);
      });

    return () => {
      active = false;
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [src]);

  if (!resolvedSrc) {
    return (
      <div className={`flex items-center justify-center bg-slate-100 text-slate-400 ${className}`}>
        <ImageIcon className="w-5 h-5" />
      </div>
    );
  }
  return <img src={resolvedSrc} alt={alt} className={className} />;
}

export function AuthPdfViewer({ src, title = 'Bản scan PDF', className = '' }) {
  const [resolvedSrc, setResolvedSrc] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    let blobUrl = null;
    setFailed(false);
    if (!src) {
      setResolvedSrc(null);
      return undefined;
    }
    if (src.startsWith('data:') || src.startsWith('http://') || src.startsWith('https://')) {
      setResolvedSrc(src);
      return undefined;
    }
    fetchAuthBlobUrl(src)
      .then((u) => {
        if (active) {
          blobUrl = u;
          setResolvedSrc(u);
        }
      })
      .catch(() => {
        if (active) {
          setResolvedSrc(null);
          setFailed(true);
        }
      });

    return () => {
      active = false;
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [src]);

  if (failed) {
    return (
      <div className={`flex flex-col items-center justify-center gap-2 p-8 bg-slate-50 text-slate-500 rounded-xl ${className}`}>
        <FileText className="w-8 h-8 text-rose-400" />
        <p className="text-xs">Không thể tải tệp PDF. Vui lòng thử lại.</p>
      </div>
    );
  }

  if (!resolvedSrc) {
    return (
      <div className={`flex flex-col items-center justify-center gap-2 p-8 bg-slate-50 text-slate-400 rounded-xl ${className}`}>
        <FileText className="w-8 h-8 animate-pulse" />
        <p className="text-xs">Đang tải tài liệu PDF...</p>
      </div>
    );
  }

  return (
    <div className="w-full space-y-2">
      <div className="flex justify-end">
        <a
          href={resolvedSrc}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-xs font-medium text-primary-600 hover:text-primary-700 hover:underline"
        >
          <ExternalLink className="w-3.5 h-3.5" /> Mở PDF trong tab mới
        </a>
      </div>
      <iframe
        src={resolvedSrc}
        title={title}
        className={`w-full h-[70vh] rounded-xl border border-slate-200 bg-white ${className}`}
      />
    </div>
  );
}

export function FileUpload({
  label,
  value = [], // string[] hoặc string
  onChange,
  multiple = false,
  maxFiles = 3,
  maxSizeMB = 5,
  accept = 'image/jpeg,image/png',
  hint = 'Hỗ trợ ảnh JPG, PNG (tối đa 5MB/ảnh)',
}) {
  const inputRef = useRef(null);
  const [error, setError] = useState('');
  const files = Array.isArray(value) ? value : value ? [value] : [];
  const acceptsPdf = String(accept).toLowerCase().includes('application/pdf') || String(accept).toLowerCase().includes('.pdf');

  const handleSelect = async (e) => {
    const selected = Array.from(e.target.files || []);
    if (selected.length === 0) return;
    setError('');

    const limit = multiple ? maxFiles - files.length : 1;
    const toProcess = selected.slice(0, Math.max(0, limit));

    const encoded = [];
    for (const f of toProcess) {
      if (f.size > maxSizeMB * 1024 * 1024) {
        setError(`Tệp "${f.name}" vượt quá dung lượng tối đa ${maxSizeMB}MB.`);
        continue;
      }
      const b64 = await fileToBase64(f);
      encoded.push(b64);
    }

    if (encoded.length > 0) {
      if (multiple) {
        onChange?.([...files, ...encoded]);
      } else {
        onChange?.(encoded[0]);
      }
    }
    if (inputRef.current) inputRef.current.value = '';
  };

  const handleRemove = (idx) => {
    if (multiple) {
      onChange?.(files.filter((_, i) => i !== idx));
    } else {
      onChange?.('');
    }
  };

  return (
    <div className="space-y-1.5">
      {label ? <label className="block text-xs font-medium text-slate-700">{label}</label> : null}

      {(!multiple && files.length === 0) || (multiple && files.length < maxFiles) ? (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="w-full flex flex-col items-center justify-center gap-1.5 py-4 px-4 border-2 border-dashed border-slate-200 hover:border-primary-400 hover:bg-primary-50/30 rounded-xl transition-colors text-slate-500"
        >
          <UploadCloud className="w-5 h-5 text-primary-500" />
          <span className="text-xs font-medium text-slate-700">
            Nhấn để tải {acceptsPdf ? 'tệp scan / ảnh' : 'ảnh'} lên {multiple ? `(${files.length}/${maxFiles})` : ''}
          </span>
          {hint ? <span className="text-[11px] text-slate-400">{hint}</span> : null}
        </button>
      ) : null}

      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        onChange={handleSelect}
        className="hidden"
      />

      {error ? <p className="text-xs text-rose-600">{error}</p> : null}

      {files.length > 0 ? (
        <div className="flex flex-wrap gap-2.5 pt-1">
          {files.map((item, idx) => (
            <div
              key={idx}
              className="relative w-20 h-20 rounded-lg border border-slate-200 overflow-hidden bg-slate-50 group"
            >
              {isPdfSource(item) ? (
                <div className="w-full h-full flex flex-col items-center justify-center gap-1 bg-rose-50 text-rose-600">
                  <FileText className="w-6 h-6" />
                  <span className="text-[10px] font-bold uppercase tracking-wider">PDF</span>
                </div>
              ) : (
                <AuthImage src={item} className="w-full h-full object-cover" />
              )}
              <button
                type="button"
                onClick={() => handleRemove(idx)}
                className="absolute top-1 right-1 p-0.5 rounded-full bg-slate-900/70 text-white hover:bg-rose-600 transition-colors"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default FileUpload;

