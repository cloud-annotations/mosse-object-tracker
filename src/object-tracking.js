import * as tf from '@tensorflow/tfjs'
import * as np from './math-util'

const SIGMA = 100
const LEARNING_RATE = 0.125

const clamp = (x, lower, upper) => Math.max(lower, Math.min(x, upper))

export default {
  init: (frame, [xmin, ymin, width, height]) => {
    const [_rect, _Ai, _Bi, gaussFourier, fourierMatrix] = tf.tidy(() => {
      // Process image.
      const image = tf.browser.fromPixels(frame)
      const greyscaleImage = np.rgbToGrayscale(image)
      const imageCrop = greyscaleImage.slice([ymin, xmin], [height, width])
      const processedImage = np.preprocessImage(imageCrop)

      // Create gaussian blur centered at the region of interest.
      const center = [ymin + height / 2, xmin + width / 2]
      const gaussTensor = np.gauss([frame.height, frame.width], center, SIGMA)
      const gaussCrop = gaussTensor.slice([ymin, xmin], [height, width])

      // The rectangle is always the same size so we can just calculate the
      // fourier matrix once.
      const fourierMatrix = np.calculateFourierMatrix([height, width])

      // Calculate Ai and Bi.
      const gaussFourier = np.dft(gaussCrop, fourierMatrix)
      const imageFourier = np.dft(imageCrop, fourierMatrix)
      const processedImageFourier = np.dft(processedImage, fourierMatrix)

      const Ai = np.complexMul(
        np.complexMul(gaussFourier, np.conjugate(processedImageFourier)),
        LEARNING_RATE
      )
      const Bi = np.complexMul(
        np.complexMul(imageFourier, np.conjugate(imageFourier)),
        LEARNING_RATE
      )

      return [[xmin, ymin, width, height], Ai, Bi, gaussFourier, fourierMatrix]
    })

    let rect = _rect
    let Ai = _Ai
    let Bi = _Bi

    return {
      next: async frame => {
        const [newRect, newAi, newBi] = tf.tidy(() => {
          const [xmin, ymin, width, height] = rect

          // Process image.
          const image = tf.browser.fromPixels(frame)
          const greyscaleImage = np.rgbToGrayscale(image)
          const imageCrop = greyscaleImage.slice([ymin, xmin], [height, width])
          const processedImage = np.preprocessImage(imageCrop)

          // Calculate dx/dy
          const Hi = np.complexDiv(Ai, Bi)

          const Gi = np.complexMul(Hi, np.dft(processedImage, fourierMatrix))
          const gi = np.dft(Gi, fourierMatrix)

          const normalizedGi = np.normalize(gi[0])

          const maxValue = tf.max(normalizedGi)
          const positions = np.findIndex2d(normalizedGi, maxValue)

          const dy = tf
            .mean(positions.slice(0, 1))
            .sub(normalizedGi.shape[0] / 2)
            .round()
            .dataSync()[0]
          const dx = tf
            .mean(positions.slice(1))
            .sub(normalizedGi.shape[1] / 2)
            .round()
            .dataSync()[0]

          // TODO: This will actually break things because we always expect same
          // width and height.
          // Maybe user sees the clipped box, but the actual x/y/width/height
          // would be different.
          // actual:   [________XXX]XXX
          // return:   [________XXX]
          // internal: [_____XXXXXX]
          const newXmin = clamp(xmin - dx, 0, frame.width)
          const newYmin = clamp(ymin - dy, 0, frame.height)
          const newRect = [
            newXmin,
            newYmin,
            Math.min(width, frame.width - newXmin),
            Math.min(height, frame.height - newYmin)
          ]

          // Train on new image.
          const newImageCrop = greyscaleImage.slice(
            [newRect[1], newRect[0]],
            [newRect[3], newRect[2]]
          )

          const fi = np.preprocessImage(newImageCrop)

          const fiFf2 = np.dft(fi, fourierMatrix)
          const aPart1 = np.complexMul(
            np.complexMul(gaussFourier, np.conjugate(fiFf2)),
            LEARNING_RATE
          )
          const aPart2 = np.complexMul(Ai, 1 - LEARNING_RATE)

          const newAi = [
            aPart1[0].addStrict(aPart2[0]),
            aPart1[1].addStrict(aPart2[1])
          ]

          const bPart1 = np.complexMul(
            np.complexMul(fiFf2, np.conjugate(fiFf2)),
            LEARNING_RATE
          )
          const bPart2 = np.complexMul(Bi, 1 - LEARNING_RATE)

          const newBi = [
            bPart1[0].addStrict(bPart2[0]),
            bPart1[1].addStrict(bPart2[1])
          ]

          Ai[0].dispose()
          Ai[1].dispose()
          Bi[0].dispose()
          Bi[1].dispose()

          return [newRect, newAi, newBi, gaussFourier, fourierMatrix] // keep in tensors in memory.
        })

        rect = newRect
        Ai = newAi
        Bi = newBi

        console.log(tf.memory().numTensors)
        return rect
      }
    }
  }
}