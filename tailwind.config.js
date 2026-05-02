/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        bg:       'var(--bg)',
        s1:       'var(--s1)',
        s2:       'var(--s2)',
        s3:       'var(--s3)',
        s4:       'var(--s4)',
        t1:       'var(--t1)',
        t2:       'var(--t2)',
        t3:       'var(--t3)',
        border:   'var(--border)',
        border2:  'var(--border2)',
        green:    'var(--green)',
        red:      'var(--red)',
        blue:     'var(--blue)',
        amber:    'var(--amber)',
        purple:   'var(--purple)',
        // legacy aliases kept for compat
        success:  'var(--green)',
        danger:   'var(--red)',
        info:     'var(--blue)',
        warning:  'var(--amber)',
        surface:  'var(--s1)',
        surface2: 'var(--s2)',
        primary:  'var(--t1)',
        secondary:'var(--t2)',
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
        sans: ['Inter', 'sans-serif'],
      },
      borderRadius: { DEFAULT: '5px' },
    },
  },
  plugins: [],
}

