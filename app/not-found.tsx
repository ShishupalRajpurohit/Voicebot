"use client";

import Link from "next/link";

export default function NotFound() {
  return (
    <main style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: '60vh',
      textAlign: 'center',
      padding: '24px',
      fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    }}>
      <h1 style={{
        fontSize: 'clamp(32px, 6vw, 56px)',
        fontWeight: 800,
        margin: '0 0 12px',
        letterSpacing: '-0.04em',
        color: 'var(--fg)'
      }}>
        404
      </h1>
      <p style={{
        fontSize: 'clamp(16px, 2.5vw, 20px)',
        color: 'var(--text-muted)',
        margin: '0 0 24px',
        maxWidth: '400px'
      }}>
        Sorry, we couldn&apos;t find that page. It might have been moved or doesn&apos;t exist.
      </p>
      <Link
        href="/"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '8px',
          padding: '12px 20px',
          background: 'var(--btn-primary)',
          color: 'white',
          borderRadius: '12px',
          fontWeight: 700,
          textDecoration: 'none',
          fontSize: '15px',
          transition: 'background 0.15s, transform 0.05s'
        }}
        onMouseEnter={(e) => e.currentTarget.style.background = 'var(--btn-primary-hover)'}
        onMouseLeave={(e) => e.currentTarget.style.background = 'var(--btn-primary)'}
        onMouseDown={(e) => e.currentTarget.style.transform = 'scale(0.98)'}
        onMouseUp={(e) => e.currentTarget.style.transform = 'scale(1)'}
      >
        ← Back to Voice Assistant
      </Link>
    </main>
  );
}