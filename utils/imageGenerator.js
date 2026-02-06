import sharp from 'sharp';
import fetch from 'node-fetch';

// OG Image dimensions
const OG_WIDTH = 1200;
const OG_HEIGHT = 630;

// Card dimensions in the composite
const CARD_WIDTH = 180;
const CARD_HEIGHT = 310;
const CARD_GAP = 40;

// Background color (dark mystical)
const BG_COLOR = { r: 10, g: 10, b: 26, alpha: 1 };

/**
 * Generate an OG preview image with 3 tarot cards
 * @param {Array} cards - Array of card objects with image property
 * @param {string} frontendUrl - Base URL of frontend for fetching images
 * @returns {Promise<Buffer>} - PNG image buffer
 */
export async function generateSharePreview(cards, frontendUrl = 'https://freetarot.fun') {
  try {
    // Calculate positions for 3 cards centered
    const totalWidth = (CARD_WIDTH * 3) + (CARD_GAP * 2);
    const startX = Math.floor((OG_WIDTH - totalWidth) / 2);
    const cardY = Math.floor((OG_HEIGHT - CARD_HEIGHT) / 2);

    // Fetch and process card images
    const cardBuffers = await Promise.all(
      cards.slice(0, 3).map(async (card, index) => {
        try {
          const imageUrl = `${frontendUrl}${card.image}`;
          console.log(`[ImageGen] Fetching card image: ${imageUrl}`);

          const response = await fetch(imageUrl);
          if (!response.ok) {
            console.error(`[ImageGen] Failed to fetch ${imageUrl}: ${response.status}`);
            return null;
          }

          const buffer = await response.buffer();

          // Resize card and rotate if inverted
          let cardImage = sharp(buffer)
            .resize(CARD_WIDTH, CARD_HEIGHT, { fit: 'cover' });

          if (!card.upright) {
            cardImage = cardImage.rotate(180);
          }

          // Add rounded corners
          const roundedCorners = Buffer.from(
            `<svg><rect x="0" y="0" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" rx="12" ry="12"/></svg>`
          );

          cardImage = cardImage.composite([{
            input: roundedCorners,
            blend: 'dest-in'
          }]);

          return {
            buffer: await cardImage.toBuffer(),
            x: startX + (index * (CARD_WIDTH + CARD_GAP)),
            y: cardY
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

    // Create background with gradient effect
    const background = await sharp({
      create: {
        width: OG_WIDTH,
        height: OG_HEIGHT,
        channels: 4,
        background: BG_COLOR
      }
    })
    .png()
    .toBuffer();

    // Create gradient overlay
    const gradientSvg = `
      <svg width="${OG_WIDTH}" height="${OG_HEIGHT}">
        <defs>
          <radialGradient id="glow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" style="stop-color:rgba(212,175,55,0.15)"/>
            <stop offset="100%" style="stop-color:rgba(10,10,26,0)"/>
          </radialGradient>
        </defs>
        <rect width="100%" height="100%" fill="url(#glow)"/>
      </svg>
    `;

    // Composite all layers
    const composites = [
      { input: Buffer.from(gradientSvg), top: 0, left: 0 },
      ...validCards.map(card => ({
        input: card.buffer,
        top: card.y,
        left: card.x
      }))
    ];

    // Add position labels
    const positions = ['Pasado', 'Presente', 'Futuro'];
    for (let i = 0; i < validCards.length; i++) {
      const labelSvg = `
        <svg width="${CARD_WIDTH}" height="30">
          <text x="${CARD_WIDTH/2}" y="22"
            font-family="Arial, sans-serif"
            font-size="14"
            fill="#d4af37"
            text-anchor="middle"
            font-weight="bold"
          >${positions[i] || ''}</text>
        </svg>
      `;
      composites.push({
        input: Buffer.from(labelSvg),
        top: validCards[i].y + CARD_HEIGHT + 10,
        left: validCards[i].x
      });
    }

    // Add branding
    const brandingSvg = `
      <svg width="${OG_WIDTH}" height="60">
        <text x="${OG_WIDTH/2}" y="40"
          font-family="Georgia, serif"
          font-size="24"
          fill="#d4af37"
          text-anchor="middle"
          letter-spacing="3"
        >FREE TAROT FUN</text>
      </svg>
    `;
    composites.push({
      input: Buffer.from(brandingSvg),
      top: OG_HEIGHT - 70,
      left: 0
    });

    // Generate final image
    const finalImage = await sharp(background)
      .composite(composites)
      .png({ quality: 90 })
      .toBuffer();

    console.log(`[ImageGen] Generated preview image: ${finalImage.length} bytes`);
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
