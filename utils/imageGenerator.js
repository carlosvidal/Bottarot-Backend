import sharp from 'sharp';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Paths to assets
const ASSETS_DIR = path.join(__dirname, '..', 'assets');
const BACKGROUNDS_DIR = path.join(ASSETS_DIR, 'backgrounds');
const CARDS_DIR = path.join(ASSETS_DIR, 'cards');
const WATERMARK_PATH = path.join(ASSETS_DIR, 'watermark.svg');

// OG Image dimensions
const OG_WIDTH = 1200;
const OG_HEIGHT = 630;

// Card dimensions in the composite
const CARD_WIDTH = 180;
const CARD_HEIGHT = 310;
const CARD_GAP = 40;

/**
 * Get a random background image path
 */
function getRandomBackground() {
  try {
    const files = fs.readdirSync(BACKGROUNDS_DIR).filter(f =>
      f.endsWith('.jpg') || f.endsWith('.png') || f.endsWith('.webp')
    );
    if (files.length === 0) return null;
    const randomIndex = Math.floor(Math.random() * files.length);
    return path.join(BACKGROUNDS_DIR, files[randomIndex]);
  } catch (err) {
    console.error('[ImageGen] Error reading backgrounds:', err);
    return null;
  }
}

/**
 * Get local card image path from card data
 */
function getCardImagePath(card) {
  // card.image is like "/img/Trumps-00.webp"
  // We need to extract "Trumps-00.webp" and look in CARDS_DIR
  const imageName = card.image.split('/').pop();
  const localPath = path.join(CARDS_DIR, imageName);

  if (fs.existsSync(localPath)) {
    return localPath;
  }

  console.warn(`[ImageGen] Card not found locally: ${imageName}`);
  return null;
}

/**
 * Generate an OG preview image with 3 tarot cards
 * @param {Array} cards - Array of card objects with image property
 * @param {string} frontendUrl - Base URL of frontend (fallback, not used with local)
 * @returns {Promise<Buffer>} - PNG image buffer
 */
export async function generateSharePreview(cards, frontendUrl = 'https://freetarot.fun') {
  const startTime = Date.now();

  try {
    // Calculate positions for 3 cards centered
    const totalWidth = (CARD_WIDTH * 3) + (CARD_GAP * 2);
    const startX = Math.floor((OG_WIDTH - totalWidth) / 2);
    const cardY = Math.floor((OG_HEIGHT - CARD_HEIGHT) / 2) - 20; // Slight offset for label space

    // 1. Load background image
    let background;
    const bgPath = getRandomBackground();

    if (bgPath && fs.existsSync(bgPath)) {
      console.log(`[ImageGen] Using background: ${path.basename(bgPath)}`);
      background = await sharp(bgPath)
        .resize(OG_WIDTH, OG_HEIGHT, { fit: 'cover' })
        .toBuffer();
    } else {
      // Fallback: create solid dark background
      console.log('[ImageGen] Using fallback solid background');
      background = await sharp({
        create: {
          width: OG_WIDTH,
          height: OG_HEIGHT,
          channels: 4,
          background: { r: 10, g: 10, b: 26, alpha: 1 }
        }
      }).png().toBuffer();
    }

    // 2. Process card images (local files - much faster!)
    const cardBuffers = await Promise.all(
      cards.slice(0, 3).map(async (card, index) => {
        try {
          const cardPath = getCardImagePath(card);

          if (!cardPath) {
            console.error(`[ImageGen] Card image not found for: ${card.name}`);
            return null;
          }

          console.log(`[ImageGen] Processing card: ${card.name} (${card.upright ? 'upright' : 'inverted'})`);

          // Load and resize card
          let cardImage = sharp(cardPath)
            .resize(CARD_WIDTH, CARD_HEIGHT, { fit: 'cover' });

          // Rotate if inverted
          if (!card.upright) {
            cardImage = cardImage.rotate(180);
          }

          // Add rounded corners and border
          const roundedCornersSvg = `
            <svg width="${CARD_WIDTH}" height="${CARD_HEIGHT}">
              <rect x="0" y="0" width="${CARD_WIDTH}" height="${CARD_HEIGHT}"
                    rx="10" ry="10" fill="white"/>
            </svg>
          `;

          const cardBuffer = await cardImage
            .composite([{
              input: Buffer.from(roundedCornersSvg),
              blend: 'dest-in'
            }])
            .toBuffer();

          // Add subtle border/shadow effect
          const borderSvg = `
            <svg width="${CARD_WIDTH + 4}" height="${CARD_HEIGHT + 4}">
              <rect x="0" y="0" width="${CARD_WIDTH + 4}" height="${CARD_HEIGHT + 4}"
                    rx="12" ry="12" fill="rgba(212,175,55,0.5)"/>
            </svg>
          `;

          const cardWithBorder = await sharp(Buffer.from(borderSvg))
            .composite([{
              input: cardBuffer,
              top: 2,
              left: 2
            }])
            .png()
            .toBuffer();

          return {
            buffer: cardWithBorder,
            x: startX + (index * (CARD_WIDTH + CARD_GAP)) - 2,
            y: cardY - 2
          };
        } catch (err) {
          console.error(`[ImageGen] Error processing card ${index}:`, err);
          return null;
        }
      })
    );

    // Filter out failed cards
    const validCards = cardBuffers.filter(c => c !== null);

    if (validCards.length === 0) {
      throw new Error('No card images could be processed');
    }

    // 3. Build composites array
    const composites = [];

    // Add cards
    validCards.forEach(card => {
      composites.push({
        input: card.buffer,
        top: card.y,
        left: card.x
      });
    });

    // 4. Add position labels
    const positions = ['Pasado', 'Presente', 'Futuro'];
    for (let i = 0; i < validCards.length; i++) {
      const labelSvg = `
        <svg width="${CARD_WIDTH}" height="35">
          <text x="${CARD_WIDTH/2}" y="25"
            font-family="Georgia, serif"
            font-size="16"
            fill="#d4af37"
            text-anchor="middle"
            font-weight="bold"
            letter-spacing="2"
          >${positions[i] || ''}</text>
        </svg>
      `;
      composites.push({
        input: Buffer.from(labelSvg),
        top: validCards[i].y + CARD_HEIGHT + 15,
        left: validCards[i].x + 2
      });
    }

    // 5. Add watermark/logo
    if (fs.existsSync(WATERMARK_PATH)) {
      try {
        const watermark = await sharp(WATERMARK_PATH)
          .resize(200, 50, { fit: 'inside' })
          .toBuffer();

        composites.push({
          input: watermark,
          top: OG_HEIGHT - 70,
          left: Math.floor((OG_WIDTH - 200) / 2)
        });
      } catch (wmErr) {
        console.warn('[ImageGen] Could not add watermark:', wmErr.message);
      }
    }

    // 6. Generate final image
    const finalImage = await sharp(background)
      .composite(composites)
      .png({ quality: 85, compressionLevel: 6 })
      .toBuffer();

    const elapsed = Date.now() - startTime;
    console.log(`[ImageGen] Generated preview image: ${finalImage.length} bytes in ${elapsed}ms`);

    return finalImage;

  } catch (error) {
    console.error('[ImageGen] Error generating preview:', error);
    throw error;
  }
}

/**
 * Upload image buffer to Supabase Storage
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {Buffer} imageBuffer
 * @param {string} shareId
 * @returns {Promise<string>} - Public URL of uploaded image
 */
export async function uploadToStorage(supabase, imageBuffer, shareId) {
  const fileName = `${shareId}.png`;
  const bucket = 'share-previews';

  try {
    const { data, error } = await supabase.storage
      .from(bucket)
      .upload(fileName, imageBuffer, {
        contentType: 'image/png',
        upsert: true
      });

    if (error) {
      console.error('[ImageGen] Storage upload error:', error);
      throw error;
    }

    // Get public URL
    const { data: urlData } = supabase.storage
      .from(bucket)
      .getPublicUrl(fileName);

    console.log(`[ImageGen] Uploaded to storage: ${urlData.publicUrl}`);
    return urlData.publicUrl;

  } catch (error) {
    console.error('[ImageGen] Error uploading to storage:', error);
    throw error;
  }
}
