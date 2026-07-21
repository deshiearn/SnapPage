import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getFirestore, collection, getDocs, doc, getDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// আপনার Firebase Config দিন
const firebaseConfig = { /* Firebase Config Here */ };
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const tg = window.Telegram.WebApp;
tg.expand();

// 1. Auto Theme Detection
const applyTheme = () => {
    document.body.style.backgroundColor = tg.themeParams.bg_color || '#ffffff';
    document.body.style.color = tg.themeParams.text_color || '#000000';
};
applyTheme();
tg.onEvent('themeChanged', applyTheme);

// Initialize User
const user = tg.initDataUnsafe.user;
document.getElementById('greeting').innerText = `Hi, ${user.first_name}`;

// 2. Fetch Posts & Blue Badge Logic
async function loadPosts() {
    const feed = document.getElementById('feed');
    feed.innerHTML = '<p>Loading posts...</p>';
    
    const querySnapshot = await getDocs(collection(db, "posts"));
    feed.innerHTML = '';

    querySnapshot.forEach(async (postDoc) => {
        const post = postDoc.data();
        
        // Fetch author level for Blue Badge
        let badgeHTML = '';
        if (post.type === 'user') {
            const authorDoc = await getDoc(doc(db, "users", post.authorId));
            if (authorDoc.exists() && authorDoc.data().level === 5) {
                badgeHTML = ' <span title="Verified" class="text-blue-500">✔️</span>';
            }
        }

        const postElement = document.createElement('div');
        postElement.className = "p-4 border rounded-lg shadow-sm";
        postElement.id = `post_${postDoc.id}`; // For Deep Linking
        postElement.innerHTML = `
            <div class="flex items-center space-x-2 mb-2 cursor-pointer" onclick="openProfile('${post.authorId}', '${post.type}')">
                <div class="font-bold">${post.authorName} ${badgeHTML}</div>
            </div>
            ${post.imageUrl ? `<img src="${post.imageUrl}" class="w-full rounded-lg mb-2">` : ''}
            <p>${post.text}</p>
        `;
        feed.appendChild(postElement);
    });

    // 3. Handle Deep Link (Start Param)
    const startParam = tg.initDataUnsafe.start_param;
    if (startParam && startParam.startsWith('post_')) {
        setTimeout(() => {
            const targetPost = document.getElementById(startParam);
            if (targetPost) {
                targetPost.scrollIntoView({ behavior: 'smooth' });
                targetPost.style.border = "2px solid #3b82f6"; // Highlight
            }
        }, 1000); // Wait for render
    }
}

window.openProfile = (id, type) => {
    if (type === 'user') {
        tg.openTelegramLink(`https://t.me/user?id=${id}`);
    } else {
         // Handle Channel link logic
    }
};

loadPosts();
