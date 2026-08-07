import { describe, expect, it, jest } from '@jest/globals';
import express, { type RequestHandler } from 'express';
import request from 'supertest';

import type { IntegrationsController } from './controller.js';
import { createIntegrationsRouter } from './router.js';

const noContent: RequestHandler = (_request, response) => {
  response.status(204).end();
};

const controller = {
  createQuote: jest.fn(noContent),
  createShipment: jest.fn(noContent),
  getShipment: jest.fn(noContent),
  health: jest.fn(noContent),
} as IntegrationsController;

const authenticate: RequestHandler = (_request, _response, next) => next();

const app = express()
  .use(express.json())
  .use('/integrations', createIntegrationsRouter(controller, authenticate));

const quoteBody = {
  orderId: 'ord_1',
  origin: { country: 'PL', city: 'Warsaw', postalCode: '00-001', line1: 'Street 1' },
  destination: { country: 'DE', city: 'Berlin', postalCode: '10115', line1: 'Street 2' },
  parcel: { weightGrams: 1_000, lengthCm: 10, widthCm: 10, heightCm: 10 },
};

describe('integrations router', () => {
  it('exposes the delivery endpoints at their documented paths', async () => {
    await request(app).post('/integrations/delivery/quotes').send(quoteBody).expect(204);
    await request(app)
      .post('/integrations/delivery/shipments')
      .send({
        quoteId: 'qte_1',
        orderId: 'ord_1',
        destination: quoteBody.destination,
        parcel: quoteBody.parcel,
      })
      .expect(204);
    await request(app).get('/integrations/delivery/shipments/shp_1').expect(204);
    await request(app).get('/integrations/health').expect(204);

    expect(controller.createQuote).toHaveBeenCalledTimes(1);
    expect(controller.createShipment).toHaveBeenCalledTimes(1);
    expect(controller.getShipment).toHaveBeenCalledTimes(1);
    expect(controller.health).toHaveBeenCalledTimes(1);
  });

  it('rejects a malformed quote request before it reaches the controller', async () => {
    const withHandler = express()
      .use(express.json())
      .use('/integrations', createIntegrationsRouter(controller, authenticate))
      .use(((error: unknown, _request, response, _next) => {
        response.status(400).json({ code: (error as { code?: string }).code });
      }) as express.ErrorRequestHandler);

    const response = await request(withHandler)
      .post('/integrations/delivery/quotes')
      .send({ ...quoteBody, parcel: { ...quoteBody.parcel, weightGrams: 0 } })
      .expect(400);

    expect(response.body).toEqual({ code: 'VALIDATION_ERROR' });
    expect(controller.createQuote).not.toHaveBeenCalled();
  });
});
