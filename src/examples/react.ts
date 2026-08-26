import { AxAIOpenAIModel, ai, f, fn, react } from '@ax-llm/ax';

const apiKey = process.env.OPENAI_APIKEY;
if (!apiKey) throw new Error('Set OPENAI_APIKEY to run this example.');

const llm = ai({
  name: 'openai',
  apiKey,
  config: { model: AxAIOpenAIModel.GPT54Mini },
});

const weather = fn('getCurrentWeather')
  .description('Get the current weather for a city.')
  .arg('city', f.string('City name'))
  .returns(
    f.object({
      city: f.string(),
      temperatureC: f.number(),
      conditions: f.string(),
    })
  )
  .handler(async ({ city }) => ({
    city,
    temperatureC: 22,
    conditions: 'clear',
  }))
  .build();

const answerWeather = react(
  'question:string -> answer:string, temperatureC:number',
  {
    functions: [weather],
    maxIterations: 4,
  }
);

const result = await answerWeather.forward(llm, {
  question: 'What is the weather in Tokyo?',
});

if (result.success) {
  console.log(result.output);
} else {
  console.error(result.terminationReason, result.error, result.output);
}
