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
const LOGO_PATH = path.join(ASSETS_DIR, 'logo.png'); // PNG logo for better quality

// OG Image dimensions
const OG_WIDTH = 1200;
const OG_HEIGHT = 630;

// Card dimensions - 10% smaller than before
const CARD_WIDTH = 162;  // was 180
const CARD_HEIGHT = 279; // was 310
const CARD_GAP = 50;     // slightly more gap for rotated cards

// Rotation angles for natural look (in degrees)
const CARD_ROTATIONS = [-5, 0, 4]; // left card tilts left, middle straight, right tilts right

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
 * @returns {Promise<Buffer>} - JPG image buffer
 */
export async function generateSharePreview(cards, frontendUrl = 'https://freetarot.fun') {
  const startTime = Date.now();

  try {
    // Calculate positions for 3 cards centered
    const totalWidth = (CARD_WIDTH * 3) + (CARD_GAP * 2);
    const startX = Math.floor((OG_WIDTH - totalWidth) / 2);
    const cardY = Math.floor((OG_HEIGHT - CARD_HEIGHT) / 2);

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
          channels: 3,
          background: { r: 10, g: 10, b: 26 }
        }
      }).jpeg().toBuffer();
    }

    // 2. Process card images with rotation
    const cardBuffers = await Promise.all(
      cards.slice(0, 3).map(async (card, index) => {
        try {
          const cardPath = getCardImagePath(card);

          if (!cardPath) {
            console.error(`[ImageGen] Card image not found for: ${card.name}`);
            return null;
          }

          const rotation = CARD_ROTATIONS[index] || 0;
          console.log(`[ImageGen] Processing card: ${card.name} (${card.upright ? 'upright' : 'inverted'}, rotation: ${rotation}°)`);

          // Load and resize card
          let cardImage = sharp(cardPath)
            .resize(CARD_WIDTH, CARD_HEIGHT, { fit: 'cover' });

          // Apply 180° rotation if inverted (before stylistic rotation)
          if (!card.upright) {
            cardImage = cardImage.rotate(180);
          }

          // Add rounded corners
          const roundedCornersSvg = `
            <svg width="${CARD_WIDTH}" height="${CARD_HEIGHT}">
              <rect x="0" y="0" width="${CARD_WIDTH}" height="${CARD_HEIGHT}"
                    rx="8" ry="8" fill="white"/>
            </svg>
          `;

          let cardBuffer = await cardImage
            .composite([{
              input: Buffer.from(roundedCornersSvg),
              blend: 'dest-in'
            }])
            .png() // Need PNG for transparency during rotation
            .toBuffer();

          // Add gold border effect
          const borderWidth = CARD_WIDTH + 6;
          const borderHeight = CARD_HEIGHT + 6;
          const borderSvg = `
            <svg width="${borderWidth}" height="${borderHeight}">
              <rect x="0" y="0" width="${borderWidth}" height="${borderHeight}"
                    rx="10" ry="10" fill="rgba(212,175,55,0.6)"/>
            </svg>
          `;

          cardBuffer = await sharp(Buffer.from(borderSvg))
            .composite([{
              input: cardBuffer,
              top: 3,
              left: 3
            }])
            .png()
            .toBuffer();

          // Apply stylistic rotation if needed
          if (rotation !== 0) {
            cardBuffer = await sharp(cardBuffer)
              .rotate(rotation, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
              .png()
              .toBuffer();
          }

          // Get dimensions after rotation
          const meta = await sharp(cardBuffer).metadata();

          return {
            buffer: cardBuffer,
            width: meta.width,
            height: meta.height,
            // Center each card at its position
            x: startX + (index * (CARD_WIDTH + CARD_GAP)) + Math.floor(CARD_WIDTH / 2) - Math.floor(meta.width / 2),
            y: cardY + Math.floor(CARD_HEIGHT / 2) - Math.floor(meta.height / 2)
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
        top: Math.max(0, card.y),
        left: Math.max(0, card.x)
      });
    });

    // 4. Add logo in bottom-right corner
    if (fs.existsSync(LOGO_PATH)) {
      try {
        const logo = await sharp(LOGO_PATH)
          .resize(150, 45, { fit: 'inside' })
          .toBuffer();

        composites.push({
          input: logo,
          top: OG_HEIGHT - 55,
          left: OG_WIDTH - 165
        });
        console.log('[ImageGen] Added logo from PNG');
      } catch (logoErr) {
        console.warn('[ImageGen] Could not add logo:', logoErr.message);
      }
    } else {
      // Try SVG fallback
      const svgPath = path.join(ASSETS_DIR, 'watermark.svg');
      if (fs.existsSync(svgPath)) {
        try {
          const logo = await sharp(svgPath)
            .resize(150, 45, { fit: 'inside' })
            .toBuffer();

          composites.push({
            input: logo,
            top: OG_HEIGHT - 55,
            left: OG_WIDTH - 165
          });
          console.log('[ImageGen] Added logo from SVG fallback');
        } catch (svgErr) {
          console.warn('[ImageGen] Could not add SVG logo:', svgErr.message);
        }
      }
    }

    // 5. Generate final image as JPG (smaller file size)
    const finalImage = await sharp(background)
      .composite(composites)
      .jpeg({ quality: 85 })
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
  const fileName = `${shareId}.jpg`;
  const bucket = 'share-previews';

  try {
    const { data, error } = await supabase.storage
      .from(bucket)
      .upload(fileName, imageBuffer, {
        contentType: 'image/jpeg',
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
