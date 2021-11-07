const path = require('path');

module.exports = {
  entry: './lib/Transaction.ts',
  mode: 'production',
  externals: {
    typeorm: 'typeorm',
    '@nestjs/common/interfaces': '@nestjs/common/interfaces',
    'reflect-metadata': 'reflect-metadata',
  },
  module: {
    rules: [
      {
        test: /\.m?(t|j)sx?$/,
        exclude: /(node_modules )/,
        loader: 'babel-loader',
      },
    ],
  },
  resolve: {
    extensions: ['.ts'],
  },
  output: {
    filename: 'Transaction.js',
    globalObject: 'this',
    path: path.resolve(__dirname, 'dist'),
    library: 'nest-transaction',
    libraryTarget: 'umd',
  },
};
