// Build with:  tailwindcss -c tailwind.config.js -i src/tailwind.css -o assets/css/tailwind.css --minify
module.exports = {
  content: ['./index.html', './indexadmin.html', './assets/js/**/*.js'],
  safelist: [
    // built dynamically in assets/js/extras.js (referral tier badges)
    { pattern: /^(bg|text)-(blue|purple|pink)-(100|600)$/ },
  ],
  theme: { extend: {} },
  plugins: [],
};
