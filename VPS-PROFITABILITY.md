# worqer.app VPS Profitability Summary

Updated: July 22, 2026.

## OVHcloud cost assumption

The legacy OVHcloud Starter configuration has 1 vCPU, 2 GB RAM, and 20 GB SSD storage. This analysis uses **USD 4.20/month** as a planning estimate, not a guaranteed quote.

OVHcloud's current public entry plan provides 2 vCores, 4 GB RAM, and 40 GB NVMe storage from EUR 3.81/month before VAT in Spain.

Sources: [OVHcloud Starter plan code](https://support.us.ovhcloud.com/hc/en-us/articles/39499067423379-How-to-order-a-VPS), [2 GB/20 GB price reference](https://vpscompares.com/blog/ovhcloud-vps-review-2026), [current OVHcloud VPS pricing](https://www.ovhcloud.com/es-es/vps/).

## Estimated monthly cost

| Cost | Monthly estimate |
|---|---:|
| OVH VPS | USD 4.20 |
| Domain | USD 1.67 |
| Backup/storage | USD 1.00 |
| Monitoring and email | USD 5.00 |
| Contingency | USD 2.13 |
| **Estimated base cost** | **USD 14.00** |

This excludes taxes, development time, marketing, intensive support, and paid Firebase or Vercel usage.

## Practical VPS capacity

A 2 GB/20 GB VPS is suitable for demos or light workloads, not shared production hosting.

- One build at a time.
- Approximately 1-3 lightweight containers.
- Approximately 5-15 small repositories, depending on image size.
- Docker images, build cache, and logs can quickly exhaust 20 GB.
- Upgrade to 4 GB/40 GB before hosting multiple customer workloads.

## Model A: customers provide their workers

worqer.app hosts the control experience while customers run the `:py` or `:go` worker on their own infrastructure.

Assumptions: USD 14 fixed monthly cost, payment fee of 4% + USD 0.30, and USD 1-2 support cost per customer.

| Price | Contribution per customer | Customers to cover USD 14 |
|---|---:|---:|
| USD 5/month | USD 3.50 | 4 |
| USD 9/month | USD 6.84 | 3 |
| USD 15/month | USD 12.10 | 2 |

This is the recommended launch model because infrastructure cost does not grow directly with every customer deployment.

## Model B: worqer.app provides one VPS per customer

Estimated infrastructure cost is **USD 6/customer/month**, including the VPS and a small operations reserve. The table also assumes USD 50 in shared monthly expenses.

| Price | Margin per customer | Customers to cover USD 50 |
|---|---:|---:|
| USD 9/month | USD 0.34 | 148 |
| USD 15/month | USD 6.10 | 9 |
| USD 19/month | USD 9.44 | 6 |
| USD 25/month | USD 14.70 | 4 |

A managed VPS is not viable at USD 9. A reasonable starting price is **USD 19-25/month** with clear build, storage, and container limits.

## Recommendation

- Free: customer-provided worker with product limits.
- Developer: USD 9/month with customer-provided workers.
- Team: USD 19/month with collaboration features.
- Managed Worker: from USD 25/month with a dedicated small VPS.

Start with the customer-provided worker model. Recalculate pricing after 10 paying customers using actual payment fees, support hours, build duration, RAM, disk, Firebase, and Vercel costs.
