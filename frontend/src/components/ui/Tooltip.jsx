import React from 'react';

export function Tooltip({ content, children }) {
  if (!content) return children;
  return (
    <span className="relative group inline-flex items-center">
      {children}
      <span className="pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity duration-150 absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 px-2.5 py-1 rounded-md bg-slate-900 text-white text-xs w-max max-w-xs whitespace-normal break-words text-center z-40 shadow-lg">
        {content}
      </span>
    </span>
  );
}

export default Tooltip;

